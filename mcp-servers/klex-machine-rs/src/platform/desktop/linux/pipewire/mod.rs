//! A minimal pure-Rust PipeWire video consumer, so the static musl build can
//! read screencast frames without libpipewire.
//!
//! It speaks the native protocol on the socket the ScreenCast portal hands
//! out and exports one `client-node` (version 5) with a single video input
//! port, as `pw_stream` does. It offers only memfd and in-buffer memory and
//! 32-bit RGB formats without modifiers, so producers fall back to shared
//! memory instead of DMA-BUF. Each graph cycle copies the newest frame out
//! and recycles the buffer at once.
//!
//! The graph runs through shared activation records: when our eventfd fires
//! we consume the IO area, mark ourselves finished and decrement the
//! `pending` counter of every node we were told to trigger, signalling those
//! that reach zero. The fields used sit at the start of
//! `struct pw_node_activation`, whose layout PipeWire keeps stable for
//! older clients.

mod memory;
mod pod;
mod wire;

use std::collections::HashMap;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use memory::{Mapping, MemPool};
use pod::{CHOICE_ENUM, CHOICE_FLAGS, CHOICE_RANGE, Value};
use wire::{Connection, Message};

const CORE: u32 = 0;
const CLIENT: u32 = 1;
const NODE: u32 = 2;
const CORE_VERSION: i32 = 4;
const CLIENT_NODE_VERSION: i32 = 5;
const INVALID: u32 = u32::MAX;

const CORE_HELLO: u8 = 1;
const CORE_PONG: u8 = 3;
const CORE_CREATE_OBJECT: u8 = 6;
const CLIENT_UPDATE_PROPERTIES: u8 = 2;
const NODE_UPDATE: u8 = 2;
const NODE_PORT_UPDATE: u8 = 3;
const NODE_SET_ACTIVE: u8 = 4;

const PARAM_ENUM_FORMAT: u32 = 3;
const PARAM_FORMAT: u32 = 4;
const PARAM_BUFFERS: u32 = 5;
const PARAM_IO: u32 = 7;
const PARAM_INFO_READ: i32 = 1 << 1;
const PARAM_INFO_WRITE: i32 = 1 << 2;

const OBJECT_FORMAT: u32 = 0x40003;
const OBJECT_BUFFERS: u32 = 0x40004;
const OBJECT_IO: u32 = 0x40006;
const FORMAT_MEDIA_TYPE: u32 = 1;
const FORMAT_MEDIA_SUBTYPE: u32 = 2;
const FORMAT_VIDEO_FORMAT: u32 = 0x20001;
const FORMAT_VIDEO_MODIFIER: u32 = 0x20002;
const FORMAT_VIDEO_SIZE: u32 = 0x20003;
const FORMAT_VIDEO_FRAMERATE: u32 = 0x20004;
const FORMAT_VIDEO_MAX_FRAMERATE: u32 = 0x20005;
const MEDIA_TYPE_VIDEO: u32 = 2;
const MEDIA_SUBTYPE_RAW: u32 = 1;
const BUFFERS_BUFFERS: u32 = 1;
const BUFFERS_BLOCKS: u32 = 2;
const BUFFERS_DATA_TYPE: u32 = 6;
const IO_ID: u32 = 1;
const IO_SIZE: u32 = 2;

const DATA_MEM_PTR: u32 = 1;
const DATA_MEM_FD: u32 = 2;
const DATA_MEM_ID: u32 = 4;

const IO_BUFFERS: u32 = 1;
const IO_CLOCK: u32 = 3;
const IO_POSITION: u32 = 7;
const STATUS_NEED_DATA: u32 = 1 << 0;
const STATUS_HAVE_DATA: u32 = 1 << 1;
const COMMAND_PAUSE: u32 = 1;
const COMMAND_START: u32 = 2;

// struct pw_node_activation
const ACTIVATION_STATUS: usize = 0;
const ACTIVATION_FLAGS: usize = 4;
const ACTIVATION_STATE_STATUS: usize = 8;
const ACTIVATION_STATE_PENDING: usize = 16;
const ACTIVATION_SIGNAL_TIME: usize = 32;
const ACTIVATION_AWAKE_TIME: usize = 40;
const ACTIVATION_FINISH_TIME: usize = 48;
const ACTIVATION_SIZE: usize = 64;
const TRIGGERED: u32 = 1;
const AWAKE: u32 = 2;
const FINISHED: u32 = 3;
const PENDING_SYNC: u32 = 1 << 1;

// struct spa_chunk
const CHUNK_SIZE: usize = 16;

/// Pixel layouts offered, most preferred first: (SPA video format, the
/// byte positions of blue, green and red in each 4-byte pixel).
const FORMATS: [(u32, [usize; 3]); 8] = [
    (8, [0, 1, 2]),  // BGRx
    (12, [0, 1, 2]), // BGRA
    (7, [2, 1, 0]),  // RGBx
    (11, [2, 1, 0]), // RGBA
    (9, [3, 2, 1]),  // xRGB
    (13, [3, 2, 1]), // ARGB
    (10, [1, 2, 3]), // xBGR
    (14, [1, 2, 3]), // ABGR
];
const MAX_DIMENSION: u32 = 16_384;

/// One frame as packed BGRX rows.
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgrx: Arc<Vec<u8>>,
    /// Increases with every frame of this stream.
    pub sequence: u64,
}

#[derive(Default)]
struct State {
    frame: Option<Frame>,
    ended: Option<String>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn end(&self, reason: String) {
        let mut state = self.lock();
        state.ended.get_or_insert(reason);
        self.changed.notify_all();
    }
}

/// A running consumer of one PipeWire video node, on its own thread.
pub struct VideoStream {
    shared: Arc<Shared>,
    stop: OwnedFd,
    thread: Option<JoinHandle<()>>,
}

impl VideoStream {
    /// Connects to the PipeWire remote `socket` and asks the session manager
    /// to link node `target` to us.
    pub fn connect(socket: OwnedFd, target: u32) -> Result<Self, String> {
        let stop = eventfd().map_err(|error| format!("eventfd: {error}"))?;
        let stop_fd = stop.as_raw_fd();
        let shared = Arc::new(Shared::default());
        let mut client = Client::new(socket, target, shared.clone());
        client
            .start()
            .map_err(|error| format!("Could not talk to PipeWire: {error}"))?;
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("pipewire".into())
            .spawn(move || {
                let reason = match client.run(stop_fd) {
                    Ok(()) => "The screen stream stopped".to_string(),
                    Err(error) => error,
                };
                thread_shared.end(reason);
            })
            .map_err(|error| format!("Could not start the PipeWire thread: {error}"))?;
        Ok(Self {
            shared,
            stop,
            thread: Some(thread),
        })
    }

    pub fn latest(&self) -> Option<Frame> {
        self.shared.lock().frame.clone()
    }

    /// Why the stream ended, once it has.
    pub fn ended(&self) -> Option<String> {
        self.shared.lock().ended.clone()
    }

    /// Waits for a frame newer than `after`, or for the stream to end.
    pub fn wait_newer(&self, after: u64, timeout: Duration) -> Result<Option<Frame>, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.shared.lock();
        loop {
            if let Some(frame) = state.frame.as_ref().filter(|frame| frame.sequence > after) {
                return Ok(Some(frame.clone()));
            }
            if let Some(reason) = &state.ended {
                return Err(reason.clone());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            state = self
                .shared
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

impl Drop for VideoStream {
    fn drop(&mut self) {
        let _ = write_eventfd(self.stop.as_raw_fd());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Format {
    video: u32,
    width: u32,
    height: u32,
}

struct Buffer {
    skeleton: Mapping,
    /// Offset of the first chunk in the skeleton.
    chunks: usize,
    data: Data,
}

enum Data {
    Mapped(Mapping),
    /// Bytes inside the skeleton at this offset.
    Inline(usize, usize),
    Unreadable,
}

struct Target {
    node: u32,
    activation: Mapping,
    signal: Option<OwnedFd>,
}

struct Client {
    connection: Connection,
    target: u32,
    shared: Arc<Shared>,
    pool: MemPool,
    activation: Option<Mapping>,
    wake: Option<OwnedFd>,
    clock: Option<Mapping>,
    position: Option<Mapping>,
    targets: Vec<Target>,
    io: HashMap<u32, Mapping>,
    buffers: HashMap<u32, Vec<Buffer>>,
    format: Option<Format>,
    sequence: u64,
}

impl Client {
    fn new(socket: OwnedFd, target: u32, shared: Arc<Shared>) -> Self {
        Self {
            connection: Connection::new(socket),
            target,
            shared,
            pool: MemPool::default(),
            activation: None,
            wake: None,
            clock: None,
            position: None,
            targets: Vec::new(),
            io: HashMap::new(),
            buffers: HashMap::new(),
            format: None,
            sequence: 0,
        }
    }

    fn start(&mut self) -> io::Result<()> {
        let pid = std::process::id().to_string();
        self.connection.send(
            CORE,
            CORE_HELLO,
            &Value::Struct(vec![Value::Int(CORE_VERSION)]),
        )?;
        self.connection.send(
            CLIENT,
            CLIENT_UPDATE_PROPERTIES,
            &Value::Struct(vec![dict(&[
                ("application.name", "klex-machine"),
                ("application.process.id", &pid),
            ])]),
        )?;
        let target = self.target.to_string();
        let properties = [
            ("node.name", "klex-machine"),
            ("node.description", "Klex screen stream"),
            ("media.name", "Klex screen stream"),
            ("media.type", "Video"),
            ("media.category", "Capture"),
            ("media.role", "Screen"),
            ("media.class", "Stream/Input/Video"),
            ("node.autoconnect", "true"),
            ("node.want-driver", "true"),
            ("node.dont-reconnect", "true"),
            ("node.target", &target),
        ];
        self.connection.send(
            CORE,
            CORE_CREATE_OBJECT,
            &Value::Struct(vec![
                Value::string("client-node"),
                Value::string("PipeWire:Interface:ClientNode"),
                Value::Int(CLIENT_NODE_VERSION),
                dict(&properties),
                Value::Int(NODE as i32),
            ]),
        )?;
        let mut info = vec![
            Value::Int(1),
            Value::Int(0),
            Value::Long(0b111),
            Value::Long(1),
            Value::Int(properties.len() as i32),
        ];
        for (key, value) in properties {
            info.push(Value::string(key));
            info.push(Value::string(value));
        }
        info.push(Value::Int(0));
        self.connection.send(
            NODE,
            NODE_UPDATE,
            &Value::Struct(vec![Value::Int(0b11), Value::Int(0), Value::Struct(info)]),
        )?;
        self.port_update()
    }

    fn port_update(&mut self) -> io::Result<()> {
        let mut params = vec![enum_format(), buffers_param(), io_param()];
        let mut format_flags = PARAM_INFO_WRITE;
        if let Some(format) = self.format {
            params.push(format_param(format));
            format_flags |= PARAM_INFO_READ;
        }
        let mut body = vec![
            Value::Int(0),
            Value::Int(0),
            Value::Int(0b11),
            Value::Int(params.len() as i32),
        ];
        body.extend(params);
        let mut info = vec![
            Value::Long(0b1111),
            Value::Long(0),
            Value::Int(0),
            Value::Int(1),
            Value::Int(1),
            Value::string("port.name"),
            Value::string("input"),
            Value::Int(4),
        ];
        for (id, flags) in [
            (PARAM_ENUM_FORMAT, PARAM_INFO_READ),
            (PARAM_FORMAT, format_flags),
            (PARAM_BUFFERS, PARAM_INFO_READ),
            (PARAM_IO, PARAM_INFO_READ),
        ] {
            info.push(Value::Id(id));
            info.push(Value::Int(flags));
        }
        body.push(Value::Struct(info));
        self.connection
            .send(NODE, NODE_PORT_UPDATE, &Value::Struct(body))
    }

    fn run(&mut self, stop: RawFd) -> Result<(), String> {
        loop {
            let mut fds = vec![poll_fd(stop), poll_fd(self.connection.raw_fd())];
            if let Some(wake) = &self.wake {
                fds.push(poll_fd(wake.as_raw_fd()));
            }
            // SAFETY: `fds` is a valid array of pollfd for the call.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, 1000) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("poll: {error}"));
            }
            if fds[0].revents != 0 {
                return Ok(());
            }
            if fds.get(2).is_some_and(|fd| fd.revents & libc::POLLIN != 0) {
                self.process();
            }
            if fds[1].revents != 0 {
                let open = self
                    .connection
                    .receive()
                    .map_err(|error| format!("PipeWire connection failed: {error}"))?;
                while let Some(message) = self.connection.next_message()? {
                    self.handle(message)?;
                }
                if !open {
                    return Err("PipeWire closed the screen stream".into());
                }
            }
        }
    }

    fn handle(&mut self, mut message: Message) -> Result<(), String> {
        let field = |message: &Message, index: usize| message.fields().get(index).cloned();
        let int = |message: &Message, index: usize| {
            message
                .fields()
                .get(index)
                .and_then(Value::as_u32)
                .unwrap_or(INVALID)
        };
        match (message.id, message.opcode) {
            (CORE, 2) => {
                let reply = Value::Struct(vec![
                    field(&message, 0).unwrap_or(Value::Int(0)),
                    field(&message, 1).unwrap_or(Value::Int(0)),
                ]);
                self.connection
                    .send(CORE, CORE_PONG, &reply)
                    .map_err(|error| error.to_string())?;
            }
            (CORE, 3) => {
                let id = int(&message, 0);
                let text = field(&message, 3)
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_default();
                if id == CORE || id == NODE {
                    return Err(format!("PipeWire refused the screen stream: {text}"));
                }
            }
            (CORE, 4) if int(&message, 0) == NODE => {
                return Err("PipeWire removed the screen stream".into());
            }
            (CORE, 6) => {
                let fd = message.take_fd(field(&message, 2).and_then(|value| value.as_fd()));
                if let Some(fd) = fd {
                    self.pool.add(int(&message, 0), fd, int(&message, 3));
                }
            }
            (CORE, 7) => self.pool.remove(int(&message, 0)),
            (NODE, 0) => self.transport(&mut message)?,
            (NODE, 2) => {
                let mapping = self.map(int(&message, 1), int(&message, 2), int(&message, 3));
                match int(&message, 0) {
                    IO_CLOCK => self.clock = mapping,
                    IO_POSITION => self.position = mapping,
                    _ => {}
                }
            }
            (NODE, 4) => {
                if let Some(Value::Object { id, .. }) = field(&message, 0) {
                    match id {
                        COMMAND_START | COMMAND_PAUSE => {}
                        _ => self.buffers.clear(),
                    }
                }
            }
            (NODE, 7) if int(&message, 2) == PARAM_FORMAT => {
                self.format = field(&message, 4).and_then(|param| parse_format(&param));
                self.buffers.clear();
                self.port_update().map_err(|error| error.to_string())?;
            }
            (NODE, 8) => self.use_buffers(&message),
            (NODE, 9) if int(&message, 3) == IO_BUFFERS => {
                let mix = int(&message, 2);
                match self.map(int(&message, 4), int(&message, 5), int(&message, 6)) {
                    Some(mapping) => {
                        self.io.insert(mix, mapping);
                    }
                    None => {
                        self.io.remove(&mix);
                    }
                }
            }
            (NODE, 10) => {
                let node = int(&message, 0);
                let signal = message.take_fd(field(&message, 1).and_then(|value| value.as_fd()));
                self.targets.retain(|target| target.node != node);
                if let Some(activation) =
                    self.map(int(&message, 2), int(&message, 3), int(&message, 4))
                {
                    self.targets.push(Target {
                        node,
                        activation,
                        signal,
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn map(&self, id: u32, offset: u32, size: u32) -> Option<Mapping> {
        if id == INVALID || size == 0 {
            return None;
        }
        self.pool.map(id, offset, size).ok()
    }

    fn transport(&mut self, message: &mut Message) -> Result<(), String> {
        let fields = message.fields().to_vec();
        let wake = message.take_fd(fields.first().and_then(Value::as_fd));
        let number = |index: usize| fields.get(index).and_then(Value::as_u32).unwrap_or(INVALID);
        let activation = self
            .map(number(2), number(3), number(4))
            .filter(|mapping| mapping.len() >= ACTIVATION_SIZE)
            .ok_or("PipeWire sent an unusable activation record")?;
        self.activation = Some(activation);
        self.wake = Some(wake.ok_or("PipeWire sent no wakeup descriptor")?);
        self.connection
            .send(
                NODE,
                NODE_SET_ACTIVE,
                &Value::Struct(vec![Value::Bool(true)]),
            )
            .map_err(|error| error.to_string())
    }

    fn use_buffers(&mut self, message: &Message) {
        let fields = message.fields();
        let number = |index: usize| fields.get(index).and_then(Value::as_u32).unwrap_or(0);
        let mix = number(2);
        let count = number(4) as usize;
        let mut at = 5;
        let mut buffers = Vec::with_capacity(count.min(64));
        for _ in 0..count.min(64) {
            let (mem, offset, size) = (number(at), number(at + 1), number(at + 2));
            let metas = number(at + 3) as usize;
            at += 4;
            let mut chunks = 0;
            for _ in 0..metas.min(16) {
                chunks += (number(at + 1) as usize).next_multiple_of(8);
                at += 2;
            }
            let datas = number(at) as usize;
            at += 1;
            let mut first = None;
            for index in 0..datas.min(64) {
                let entry = (number(at), number(at + 1), number(at + 3), number(at + 4));
                if index == 0 {
                    first = Some(entry);
                }
                at += 5;
            }
            let Some(skeleton) = self.map(mem, offset, size) else {
                buffers.clear();
                break;
            };
            let data = match first {
                Some((DATA_MEM_ID, id, map_offset, max_size)) => self
                    .map(id, map_offset, max_size)
                    .map_or(Data::Unreadable, Data::Mapped),
                Some((DATA_MEM_PTR, offset, _, max_size)) => {
                    Data::Inline(offset as usize, max_size as usize)
                }
                _ => Data::Unreadable,
            };
            buffers.push(Buffer {
                skeleton,
                chunks,
                data,
            });
        }
        self.buffers.insert(mix, buffers);
    }

    /// One graph cycle.
    fn process(&mut self) {
        if let Some(wake) = &self.wake {
            let _ = read_eventfd(wake.as_raw_fd());
        }
        let now = monotonic_ns();
        if let Some(activation) = &self.activation {
            activation.store_u32(ACTIVATION_STATUS, AWAKE);
            activation.store_u64(ACTIVATION_AWAKE_TIME, now);
            if let Some(flags) = activation.u32_at(ACTIVATION_FLAGS) {
                flags.fetch_and(!PENDING_SYNC, Ordering::AcqRel);
            }
        }
        let mixes: Vec<u32> = self.io.keys().copied().collect();
        for mix in mixes {
            self.consume(mix);
        }
        let finished = monotonic_ns();
        if let Some(activation) = &self.activation {
            activation.store_u32(ACTIVATION_STATE_STATUS, STATUS_NEED_DATA | STATUS_HAVE_DATA);
            activation.store_u32(ACTIVATION_STATUS, FINISHED);
            activation.store_u64(ACTIVATION_FINISH_TIME, finished);
        }
        if self.driving() {
            return;
        }
        for target in &self.targets {
            let Some(pending) = target.activation.i32_at(ACTIVATION_STATE_PENDING) else {
                continue;
            };
            if pending.fetch_sub(1, Ordering::AcqRel) == 1 {
                target.activation.store_u32(ACTIVATION_STATUS, TRIGGERED);
                target
                    .activation
                    .store_u64(ACTIVATION_SIGNAL_TIME, finished);
                if let Some(signal) = &target.signal {
                    let _ = write_eventfd(signal.as_raw_fd());
                }
            }
        }
    }

    /// Whether this node drives the graph, in which case nobody waits on it.
    fn driving(&self) -> bool {
        match (&self.clock, &self.position) {
            (Some(clock), Some(position)) => clock.load_u32(4) == position.load_u32(4),
            _ => false,
        }
    }

    fn consume(&mut self, mix: u32) {
        let Some(io) = self.io.get(&mix) else {
            return;
        };
        let (Some(status), Some(id)) = (io.load_u32(0), io.load_u32(4)) else {
            return;
        };
        if status != STATUS_HAVE_DATA {
            return;
        }
        let buffers = self
            .buffers
            .get(&mix)
            .or_else(|| self.buffers.get(&INVALID));
        if let (Some(buffer), Some(format)) = (
            buffers.and_then(|buffers| buffers.get(id as usize)),
            self.format,
        ) && let Some(bgrx) = read_frame(buffer, format)
        {
            self.sequence += 1;
            let frame = Frame {
                width: format.width,
                height: format.height,
                bgrx: Arc::new(bgrx),
                sequence: self.sequence,
            };
            let mut state = self.shared.lock();
            state.frame = Some(frame);
            self.shared.changed.notify_all();
        }
        io.store_u32(4, id);
        io.store_u32(0, STATUS_NEED_DATA);
    }
}

fn read_frame(buffer: &Buffer, format: Format) -> Option<Vec<u8>> {
    let chunk = buffer.skeleton.bytes(buffer.chunks, CHUNK_SIZE)?;
    let word = |at: usize| u32::from_ne_bytes(chunk[at..at + 4].try_into().unwrap_or_default());
    let (offset, size, stride, flags) =
        (word(0) as usize, word(4) as usize, word(8) as i32, word(12));
    if size == 0 || flags & 0b11 != 0 {
        return None;
    }
    let row = format.width as usize * 4;
    let stride = if stride > 0 { stride as usize } else { row };
    let order = FORMATS.iter().find(|(video, _)| *video == format.video)?.1;
    let (source, base, limit) = match &buffer.data {
        Data::Mapped(mapping) => (mapping, 0, mapping.len()),
        Data::Inline(at, max) => (&buffer.skeleton, *at, *max),
        Data::Unreadable => return None,
    };
    let offset = offset % limit.max(1);
    let needed = stride * (format.height as usize - 1) + row;
    if stride < row || offset + needed > limit {
        return None;
    }
    let bytes = source.bytes(base + offset, needed)?;
    let mut out = Vec::with_capacity(row * format.height as usize);
    for y in 0..format.height as usize {
        let line = &bytes[y * stride..y * stride + row];
        if order == [0, 1, 2] {
            out.extend_from_slice(line);
            continue;
        }
        for pixel in line.as_chunks::<4>().0 {
            out.extend_from_slice(&[pixel[order[0]], pixel[order[1]], pixel[order[2]], 0]);
        }
    }
    Some(out)
}

fn parse_format(param: &Value) -> Option<Format> {
    if param.property(FORMAT_MEDIA_TYPE)?.current().as_id()? != MEDIA_TYPE_VIDEO
        || param.property(FORMAT_MEDIA_SUBTYPE)?.current().as_id()? != MEDIA_SUBTYPE_RAW
        || param.property(FORMAT_VIDEO_MODIFIER).is_some()
    {
        return None;
    }
    let video = param.property(FORMAT_VIDEO_FORMAT)?.current().as_id()?;
    let Value::Rectangle(width, height) = param.property(FORMAT_VIDEO_SIZE)?.current() else {
        return None;
    };
    let valid = |value: u32| (1..=MAX_DIMENSION).contains(&value);
    (FORMATS.iter().any(|(id, _)| *id == video) && valid(*width) && valid(*height)).then_some(
        Format {
            video,
            width: *width,
            height: *height,
        },
    )
}

fn dict(items: &[(&str, &str)]) -> Value {
    let mut values = vec![Value::Int(items.len() as i32)];
    for (key, value) in items {
        values.push(Value::string(key));
        values.push(Value::string(value));
    }
    Value::Struct(values)
}

fn video_header() -> Vec<(u32, Value)> {
    vec![
        (FORMAT_MEDIA_TYPE, Value::Id(MEDIA_TYPE_VIDEO)),
        (FORMAT_MEDIA_SUBTYPE, Value::Id(MEDIA_SUBTYPE_RAW)),
    ]
}

fn enum_format() -> Value {
    let mut formats = vec![Value::Id(FORMATS[0].0)];
    formats.extend(FORMATS.iter().map(|(id, _)| Value::Id(*id)));
    let mut properties = video_header();
    properties.extend([
        (
            FORMAT_VIDEO_FORMAT,
            Value::Choice {
                kind: CHOICE_ENUM,
                values: formats,
            },
        ),
        (
            FORMAT_VIDEO_SIZE,
            Value::Choice {
                kind: CHOICE_RANGE,
                values: vec![
                    Value::Rectangle(1920, 1080),
                    Value::Rectangle(1, 1),
                    Value::Rectangle(MAX_DIMENSION, MAX_DIMENSION),
                ],
            },
        ),
        (
            FORMAT_VIDEO_FRAMERATE,
            Value::Choice {
                kind: CHOICE_RANGE,
                values: vec![
                    Value::Fraction(0, 1),
                    Value::Fraction(0, 1),
                    Value::Fraction(360, 1),
                ],
            },
        ),
        (
            FORMAT_VIDEO_MAX_FRAMERATE,
            Value::Choice {
                kind: CHOICE_RANGE,
                values: vec![
                    Value::Fraction(30, 1),
                    Value::Fraction(1, 1),
                    Value::Fraction(360, 1),
                ],
            },
        ),
    ]);
    Value::object(OBJECT_FORMAT, PARAM_ENUM_FORMAT, properties)
}

fn format_param(format: Format) -> Value {
    let mut properties = video_header();
    properties.extend([
        (FORMAT_VIDEO_FORMAT, Value::Id(format.video)),
        (
            FORMAT_VIDEO_SIZE,
            Value::Rectangle(format.width, format.height),
        ),
    ]);
    Value::object(OBJECT_FORMAT, PARAM_FORMAT, properties)
}

fn buffers_param() -> Value {
    Value::object(
        OBJECT_BUFFERS,
        PARAM_BUFFERS,
        vec![
            (
                BUFFERS_BUFFERS,
                Value::Choice {
                    kind: CHOICE_RANGE,
                    values: vec![Value::Int(8), Value::Int(2), Value::Int(16)],
                },
            ),
            (BUFFERS_BLOCKS, Value::Int(1)),
            (
                BUFFERS_DATA_TYPE,
                Value::Choice {
                    kind: CHOICE_FLAGS,
                    values: vec![Value::Int((1 << DATA_MEM_PTR) | (1 << DATA_MEM_FD))],
                },
            ),
        ],
    )
}

fn io_param() -> Value {
    Value::object(
        OBJECT_IO,
        PARAM_IO,
        vec![(IO_ID, Value::Id(IO_BUFFERS)), (IO_SIZE, Value::Int(8))],
    )
}

fn poll_fd(fd: RawFd) -> libc::pollfd {
    libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }
}

fn eventfd() -> io::Result<OwnedFd> {
    // SAFETY: plain syscall; the result is checked and then owned.
    let fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh descriptor nobody else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn write_eventfd(fd: RawFd) -> io::Result<()> {
    let value: u64 = 1;
    // SAFETY: writes 8 bytes from a local.
    if unsafe { libc::write(fd, (&raw const value).cast(), 8) } != 8 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn read_eventfd(fd: RawFd) -> io::Result<u64> {
    let mut value: u64 = 0;
    // SAFETY: reads 8 bytes into a local.
    if unsafe { libc::read(fd, (&raw mut value).cast(), 8) } != 8 {
        return Err(io::Error::last_os_error());
    }
    Ok(value)
}

fn monotonic_ns() -> u64 {
    // SAFETY: timespec is plain data filled by the call.
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: valid clock id and pointer.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) };
    time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64
}

#[cfg(test)]
mod tests;
