//! PipeWire native protocol framing (version 3): a 16-byte header (object
//! id, opcode and size, sequence, fd count) and one pod. File descriptors
//! travel as `SCM_RIGHTS` alongside the bytes.

use std::collections::VecDeque;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use super::pod::Value;

const HEADER: usize = 16;
const MAX_FDS: usize = 28;
const MAX_MESSAGE: usize = 1 << 24;
const READ_CHUNK: usize = 64 * 1024;

pub struct Message {
    pub id: u32,
    pub opcode: u8,
    pub body: Value,
    fds: Vec<Option<OwnedFd>>,
}

impl Message {
    /// Takes the descriptor a pod `Fd` value refers to.
    pub fn take_fd(&mut self, index: Option<i64>) -> Option<OwnedFd> {
        let index = usize::try_from(index?).ok()?;
        self.fds.get_mut(index)?.take()
    }

    pub fn fields(&self) -> &[Value] {
        match &self.body {
            Value::Struct(fields) => fields,
            _ => &[],
        }
    }
}

pub struct Connection {
    socket: OwnedFd,
    input: Vec<u8>,
    fds: VecDeque<OwnedFd>,
    seq: u32,
}

impl Connection {
    pub fn new(socket: OwnedFd) -> Self {
        Self {
            socket,
            input: Vec::new(),
            fds: VecDeque::new(),
            seq: 0,
        }
    }

    pub fn raw_fd(&self) -> RawFd {
        self.socket.as_raw_fd()
    }

    pub fn send(&mut self, id: u32, opcode: u8, body: &Value) -> io::Result<()> {
        let payload = body.to_bytes();
        let mut data = Vec::with_capacity(HEADER + payload.len());
        data.extend_from_slice(&id.to_ne_bytes());
        data.extend_from_slice(&((u32::from(opcode) << 24) | payload.len() as u32).to_ne_bytes());
        data.extend_from_slice(&self.seq.to_ne_bytes());
        data.extend_from_slice(&0u32.to_ne_bytes());
        data.extend_from_slice(&payload);
        self.seq = self.seq.wrapping_add(1);
        let mut sent = 0;
        while sent < data.len() {
            // SAFETY: the pointer and length describe `data`; MSG_NOSIGNAL
            // turns a closed peer into EPIPE instead of SIGPIPE.
            let written = unsafe {
                libc::send(
                    self.socket.as_raw_fd(),
                    data[sent..].as_ptr().cast(),
                    data.len() - sent,
                    libc::MSG_NOSIGNAL,
                )
            };
            if written < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() == io::ErrorKind::WouldBlock {
                    wait_writable(self.socket.as_raw_fd())?;
                    continue;
                }
                return Err(error);
            }
            sent += written as usize;
        }
        Ok(())
    }

    /// Reads what is available without blocking; `Ok(false)` once the peer
    /// has closed the connection.
    pub fn receive(&mut self) -> io::Result<bool> {
        let mut buffer = vec![0u8; READ_CHUNK];
        // SAFETY: CMSG_SPACE is a pure size computation.
        let control_len = unsafe { libc::CMSG_SPACE((MAX_FDS * size_of::<RawFd>()) as u32) };
        let mut control = vec![0u8; control_len as usize];
        loop {
            let mut iov = libc::iovec {
                iov_base: buffer.as_mut_ptr().cast(),
                iov_len: buffer.len(),
            };
            // SAFETY: msghdr is plain data; every pointer set below outlives
            // the recvmsg call.
            let mut header: libc::msghdr = unsafe { std::mem::zeroed() };
            header.msg_iov = &mut iov;
            header.msg_iovlen = 1;
            header.msg_control = control.as_mut_ptr().cast();
            header.msg_controllen = control.len() as _;
            // SAFETY: the header describes live buffers.
            let read = unsafe {
                libc::recvmsg(
                    self.socket.as_raw_fd(),
                    &mut header,
                    libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC,
                )
            };
            if read < 0 {
                let error = io::Error::last_os_error();
                return match error.kind() {
                    io::ErrorKind::Interrupted => continue,
                    io::ErrorKind::WouldBlock => Ok(true),
                    _ => Err(error),
                };
            }
            // SAFETY: walks the control messages recvmsg just filled in.
            unsafe {
                let mut cmsg = libc::CMSG_FIRSTHDR(&header);
                while !cmsg.is_null() {
                    if (*cmsg).cmsg_level == libc::SOL_SOCKET
                        && (*cmsg).cmsg_type == libc::SCM_RIGHTS
                    {
                        let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
                        let bytes = (*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                        for index in 0..bytes / size_of::<RawFd>() {
                            let fd = std::ptr::read_unaligned(data.add(index));
                            self.fds.push_back(OwnedFd::from_raw_fd(fd));
                        }
                    }
                    cmsg = libc::CMSG_NXTHDR(&header, cmsg);
                }
            }
            if read == 0 {
                return Ok(false);
            }
            self.input.extend_from_slice(&buffer[..read as usize]);
            if (read as usize) < buffer.len() {
                return Ok(true);
            }
        }
    }

    /// The next complete message, if one has arrived.
    pub fn next_message(&mut self) -> Result<Option<Message>, String> {
        if self.input.len() < HEADER {
            return Ok(None);
        }
        let word =
            |at: usize| u32::from_ne_bytes(self.input[at..at + 4].try_into().unwrap_or_default());
        let id = word(0);
        let opcode = (word(4) >> 24) as u8;
        let size = (word(4) & 0x00ff_ffff) as usize;
        let n_fds = word(12) as usize;
        if size > MAX_MESSAGE {
            return Err("PipeWire sent an oversized message".into());
        }
        if self.input.len() < HEADER + size {
            return Ok(None);
        }
        if n_fds > self.fds.len() {
            return Err("PipeWire sent a message without its file descriptors".into());
        }
        let fds = self.fds.drain(..n_fds).map(Some).collect();
        let payload: Vec<u8> = self.input.drain(..HEADER + size).skip(HEADER).collect();
        let body = if payload.is_empty() {
            Value::None
        } else {
            Value::decode(&payload)?.0
        };
        Ok(Some(Message {
            id,
            opcode,
            body,
            fds,
        }))
    }
}

fn wait_writable(fd: RawFd) -> io::Result<()> {
    let mut poll = libc::pollfd {
        fd,
        events: libc::POLLOUT,
        revents: 0,
    };
    // SAFETY: one valid pollfd.
    if unsafe { libc::poll(&mut poll, 1, 1000) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn frames_messages_and_passes_descriptors() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let mut client = Connection::new(ours.into());
        client
            .send(2, 4, &Value::Struct(vec![Value::Bool(true)]))
            .unwrap();
        let mut server = Connection::new(theirs.try_clone().unwrap().into());
        assert!(server.receive().unwrap());
        let message = server.next_message().unwrap().unwrap();
        assert_eq!((message.id, message.opcode), (2, 4));
        assert_eq!(message.body, Value::Struct(vec![Value::Bool(true)]));
        assert!(server.next_message().unwrap().is_none());

        // A message carrying a descriptor, written the way PipeWire does.
        let (file, _keep) = UnixStream::pair().unwrap();
        let body = Value::Struct(vec![Value::Fd(0), Value::Int(9)]).to_bytes();
        let mut data = Vec::new();
        for word in [0u32, (6 << 24) | body.len() as u32, 0, 1] {
            data.extend_from_slice(&word.to_ne_bytes());
        }
        data.extend_from_slice(&body);
        send_with_fd(&theirs, &data, file.as_raw_fd());
        assert!(client.receive().unwrap());
        let mut message = client.next_message().unwrap().unwrap();
        assert_eq!(message.opcode, 6);
        assert!(message.take_fd(Some(0)).is_some());
        assert!(message.take_fd(Some(0)).is_none());
    }

    fn send_with_fd(socket: &UnixStream, data: &[u8], fd: RawFd) {
        // SAFETY: test-only sendmsg with one descriptor.
        unsafe {
            let mut iov = libc::iovec {
                iov_base: data.as_ptr() as *mut _,
                iov_len: data.len(),
            };
            let space = libc::CMSG_SPACE(size_of::<RawFd>() as u32) as usize;
            let mut control = vec![0u8; space];
            let mut header: libc::msghdr = std::mem::zeroed();
            header.msg_iov = &mut iov;
            header.msg_iovlen = 1;
            header.msg_control = control.as_mut_ptr().cast();
            header.msg_controllen = space as _;
            let cmsg = libc::CMSG_FIRSTHDR(&header);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as _;
            std::ptr::write_unaligned(libc::CMSG_DATA(cmsg).cast::<RawFd>(), fd);
            assert!(libc::sendmsg(socket.as_raw_fd(), &header, 0) > 0);
        }
    }
}
