//! Drives the client against a scripted server on a socket pair: the
//! handshake, format and buffer negotiation, and one graph cycle.

use std::os::fd::{AsFd, AsRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use super::wire::Connection;
use super::*;

struct Server {
    socket: UnixStream,
    connection: Connection,
}

impl Server {
    fn send(&self, id: u32, opcode: u8, body: Value, fds: &[RawFd]) {
        let payload = body.to_bytes();
        let mut data = Vec::new();
        for word in [
            id,
            (u32::from(opcode) << 24) | payload.len() as u32,
            0,
            fds.len() as u32,
        ] {
            data.extend_from_slice(&word.to_ne_bytes());
        }
        data.extend_from_slice(&payload);
        // SAFETY: test-only sendmsg of live buffers and descriptors.
        unsafe {
            let mut iov = libc::iovec {
                iov_base: data.as_ptr() as *mut _,
                iov_len: data.len(),
            };
            let space = libc::CMSG_SPACE((fds.len().max(1) * size_of::<RawFd>()) as u32) as usize;
            let mut control = vec![0u8; space];
            let mut header: libc::msghdr = std::mem::zeroed();
            header.msg_iov = &mut iov;
            header.msg_iovlen = 1;
            if !fds.is_empty() {
                header.msg_control = control.as_mut_ptr().cast();
                header.msg_controllen = space as _;
                let cmsg = libc::CMSG_FIRSTHDR(&header);
                (*cmsg).cmsg_level = libc::SOL_SOCKET;
                (*cmsg).cmsg_type = libc::SCM_RIGHTS;
                (*cmsg).cmsg_len = libc::CMSG_LEN(size_of_val(fds) as u32) as _;
                for (index, fd) in fds.iter().enumerate() {
                    std::ptr::write_unaligned(
                        libc::CMSG_DATA(cmsg).cast::<RawFd>().add(index),
                        *fd,
                    );
                }
            }
            assert_eq!(
                libc::sendmsg(self.socket.as_raw_fd(), &header, 0),
                data.len() as isize
            );
        }
    }

    /// The next message from the client, waiting for it.
    fn next(&mut self) -> (u32, u8, Value) {
        for _ in 0..200 {
            if let Some(message) = self.connection.next_message().unwrap() {
                return (message.id, message.opcode, message.body);
            }
            std::thread::sleep(Duration::from_millis(10));
            self.connection.receive().unwrap();
        }
        panic!("the client sent nothing");
    }
}

fn memfd(size: usize) -> OwnedFd {
    // SAFETY: plain syscalls on a fresh descriptor.
    unsafe {
        let fd = libc::memfd_create(c"klex-test".as_ptr(), libc::MFD_CLOEXEC);
        assert!(fd >= 0);
        assert_eq!(libc::ftruncate(fd, size as libc::off_t), 0);
        OwnedFd::from_raw_fd(fd)
    }
}

fn shared(fd: &OwnedFd, size: usize) -> Mapping {
    Mapping::new(fd, 0, size, true).unwrap()
}

fn fields(value: &Value) -> &[Value] {
    match value {
        Value::Struct(fields) => fields,
        _ => &[],
    }
}

#[test]
fn negotiates_and_reads_a_frame_then_triggers_the_peer() {
    let (ours, theirs) = UnixStream::pair().unwrap();
    let mut server = Server {
        connection: Connection::new(theirs.try_clone().unwrap().into()),
        socket: theirs,
    };
    let stream = VideoStream::connect(ours.into(), 42).unwrap();

    let (id, opcode, hello) = server.next();
    assert_eq!((id, opcode), (CORE, CORE_HELLO));
    assert_eq!(fields(&hello), [Value::Int(4)]);
    assert_eq!(server.next().0, CLIENT);
    let (_, opcode, create) = server.next();
    assert_eq!(opcode, CORE_CREATE_OBJECT);
    assert_eq!(fields(&create)[0], Value::string("client-node"));
    let Value::Struct(props) = &fields(&create)[3] else {
        panic!("no properties")
    };
    let target = props
        .windows(2)
        .find(|pair| pair[0] == Value::string("node.target"))
        .map(|pair| pair[1].clone());
    assert_eq!(target, Some(Value::string("42")));
    assert_eq!(server.next().1, NODE_UPDATE);
    let (_, opcode, port) = server.next();
    assert_eq!(opcode, NODE_PORT_UPDATE);
    assert_eq!(fields(&port)[3], Value::Int(3));
    let offered = &fields(&port)[4];
    assert_eq!(
        offered.property(FORMAT_VIDEO_FORMAT).unwrap().current(),
        &Value::Id(8)
    );

    // Memory: our activation, the peer's, the IO area, and one buffer
    // whose skeleton holds a header meta and the chunk, with RGBx pixels in
    // a separate memfd.
    let (width, height, stride) = (3u32, 2u32, 16usize);
    let activation = memfd(4096);
    let peer = memfd(4096);
    let io = memfd(4096);
    let skeleton = memfd(4096);
    let pixels = memfd(4096);
    let wake = eventfd().unwrap();
    let signal = eventfd().unwrap();
    for (id, fd) in [
        (1, &activation),
        (2, &peer),
        (3, &io),
        (4, &skeleton),
        (5, &pixels),
    ] {
        server.send(
            CORE,
            6,
            Value::Struct(vec![
                Value::Int(id),
                Value::Id(DATA_MEM_FD),
                Value::Fd(0),
                Value::Int(0b11),
            ]),
            &[fd.as_raw_fd()],
        );
    }
    server.send(
        NODE,
        0,
        Value::Struct(vec![
            Value::Fd(0),
            Value::Fd(1),
            Value::Int(1),
            Value::Int(0),
            Value::Int(ACTIVATION_SIZE as i32 * 4),
        ]),
        &[wake.as_raw_fd(), wake.as_raw_fd()],
    );
    let (_, opcode, active) = server.next();
    assert_eq!(opcode, NODE_SET_ACTIVE);
    assert_eq!(fields(&active), [Value::Bool(true)]);

    let format = Value::object(
        OBJECT_FORMAT,
        PARAM_FORMAT,
        vec![
            (FORMAT_MEDIA_TYPE, Value::Id(MEDIA_TYPE_VIDEO)),
            (FORMAT_MEDIA_SUBTYPE, Value::Id(MEDIA_SUBTYPE_RAW)),
            (FORMAT_VIDEO_FORMAT, Value::Id(7)),
            (FORMAT_VIDEO_SIZE, Value::Rectangle(width, height)),
            (FORMAT_VIDEO_FRAMERATE, Value::Fraction(0, 1)),
        ],
    );
    server.send(
        NODE,
        7,
        Value::Struct(vec![
            Value::Int(0),
            Value::Int(0),
            Value::Id(PARAM_FORMAT),
            Value::Int(0),
            format,
        ]),
        &[],
    );
    let (_, opcode, update) = server.next();
    assert_eq!(opcode, NODE_PORT_UPDATE);
    assert_eq!(fields(&update)[3], Value::Int(4));

    server.send(
        NODE,
        8,
        Value::Struct(vec![
            Value::Int(0),
            Value::Int(0),
            Value::Int(0),
            Value::Int(0),
            Value::Int(1),
            Value::Int(4),
            Value::Int(0),
            Value::Int(256),
            Value::Int(1),
            Value::Id(1),
            Value::Int(16),
            Value::Int(1),
            Value::Id(DATA_MEM_ID),
            Value::Int(5),
            Value::Int(0),
            Value::Int(0),
            Value::Int(4096),
        ]),
        &[],
    );
    server.send(
        NODE,
        9,
        Value::Struct(vec![
            Value::Int(0),
            Value::Int(0),
            Value::Int(0),
            Value::Id(IO_BUFFERS),
            Value::Int(3),
            Value::Int(0),
            Value::Int(8),
        ]),
        &[],
    );
    server.send(
        NODE,
        10,
        Value::Struct(vec![
            Value::Int(7),
            Value::Fd(0),
            Value::Int(2),
            Value::Int(0),
            Value::Int(ACTIVATION_SIZE as i32 * 4),
        ]),
        &[signal.as_raw_fd()],
    );

    let chunk = shared(&skeleton, 4096);
    for (at, value) in [
        (16, 0u32),
        (20, stride as u32 * height),
        (24, stride as u32),
        (28, 0),
    ] {
        chunk.store_u32(at, value);
    }
    let image = shared(&pixels, 4096);
    for y in 0..height as usize {
        for x in 0..width as usize {
            let at = y * stride + x * 4;
            image.store_u32(at, u32::from_ne_bytes([10 * x as u8, 20 * y as u8, 7, 255]));
        }
    }
    let peer_activation = shared(&peer, 4096);
    peer_activation
        .i32_at(ACTIVATION_STATE_PENDING)
        .unwrap()
        .store(1, Ordering::SeqCst);
    let io_area = shared(&io, 4096);
    io_area.store_u32(4, 0);
    io_area.store_u32(0, STATUS_HAVE_DATA);

    // Let the client handle the setup before the cycle starts.
    std::thread::sleep(Duration::from_millis(200));
    write_eventfd(wake.as_raw_fd()).unwrap();
    let frame = stream
        .wait_newer(0, Duration::from_secs(5))
        .unwrap()
        .expect("a frame");
    assert_eq!((frame.width, frame.height), (width, height));
    assert_eq!(&frame.bgrx[..12], [7, 0, 0, 0, 7, 0, 10, 0, 7, 0, 20, 0]);
    assert_eq!(&frame.bgrx[12..16], [7, 20, 0, 0]);

    let mut tries = 0;
    while read_eventfd(signal.as_fd().as_raw_fd()).is_err() {
        tries += 1;
        assert!(tries < 200, "the peer was never signalled");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        peer_activation
            .i32_at(ACTIVATION_STATE_PENDING)
            .unwrap()
            .load(Ordering::SeqCst),
        0
    );
    assert_eq!(peer_activation.load_u32(ACTIVATION_STATUS), Some(TRIGGERED));
    assert_eq!(io_area.load_u32(0), Some(STATUS_NEED_DATA));
    assert_eq!(io_area.load_u32(4), Some(0));
    assert_eq!(
        shared(&activation, 4096).load_u32(ACTIVATION_STATUS),
        Some(FINISHED)
    );

    server.send(
        CORE,
        3,
        Value::Struct(vec![
            Value::Int(NODE as i32),
            Value::Int(0),
            Value::Int(-1),
            Value::string("no permission"),
        ]),
        &[],
    );
    assert_eq!(
        stream.wait_newer(1, Duration::from_secs(5)).unwrap_err(),
        "PipeWire refused the screen stream: no permission"
    );
}

#[test]
fn converts_every_offered_layout_to_bgrx() {
    let format = |video| Format {
        video,
        width: 1,
        height: 1,
    };
    let memory = memfd(4096);
    let skeleton = shared(&memory, 4096);
    skeleton.store_u32(4, 4);
    skeleton.store_u32(8, 4);
    skeleton.store_u32(16, u32::from_ne_bytes([1, 2, 3, 4]));
    let buffer = Buffer {
        skeleton,
        chunks: 0,
        data: Data::Inline(16, 4),
    };
    let expected = [
        (8, [1, 2, 3]),
        (12, [1, 2, 3]),
        (7, [3, 2, 1]),
        (11, [3, 2, 1]),
        (9, [4, 3, 2]),
        (13, [4, 3, 2]),
        (10, [2, 3, 4]),
        (14, [2, 3, 4]),
    ];
    for (video, bgr) in expected {
        let out = read_frame(&buffer, format(video)).unwrap();
        assert_eq!(&out[..3], bgr, "format {video}");
    }
}

#[test]
fn rejects_formats_it_did_not_offer() {
    let format = |video, modifier: bool| {
        let mut properties = vec![
            (FORMAT_MEDIA_TYPE, Value::Id(MEDIA_TYPE_VIDEO)),
            (FORMAT_MEDIA_SUBTYPE, Value::Id(MEDIA_SUBTYPE_RAW)),
            (FORMAT_VIDEO_FORMAT, Value::Id(video)),
            (FORMAT_VIDEO_SIZE, Value::Rectangle(640, 480)),
        ];
        if modifier {
            properties.push((FORMAT_VIDEO_MODIFIER, Value::Long(0)));
        }
        Value::object(OBJECT_FORMAT, PARAM_FORMAT, properties)
    };
    assert_eq!(
        parse_format(&format(8, false)),
        Some(Format {
            video: 8,
            width: 640,
            height: 480
        })
    );
    assert_eq!(parse_format(&format(2, false)), None);
    assert_eq!(parse_format(&format(8, true)), None);
}
