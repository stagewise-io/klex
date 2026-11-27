//! Where macOS desktop calls run. Each call gets its own detached thread and
//! a deadline, so a hung window server call fails the operation instead of
//! blocking the server or its shutdown. Calls that AppKit and the Text Input
//! Sources API only allow on the main thread run on the main run loop, which
//! `host` frees for them.

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dispatch2::DispatchQueue;
use objc2_core_foundation::{CFRunLoop, CFRunLoopTimer, kCFRunLoopDefaultMode};

static HOSTED: AtomicBool = AtomicBool::new(false);

const MAIN_STACK_BYTES: usize = 8 * 1024 * 1024;

/// Runs `work` on a new thread while this, the main thread, serves the main
/// run loop, and returns its result once it finishes.
pub fn host<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let result = Arc::new(Mutex::new(None));
    let slot = result.clone();
    let spawned = std::thread::Builder::new()
        .name("klex-machine".into())
        .stack_size(MAIN_STACK_BYTES)
        .spawn(move || {
            let outcome = catch_unwind(AssertUnwindSafe(work));
            *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(outcome);
            // Runs inside the run loop, so the stop cannot be lost.
            DispatchQueue::main().exec_async(|| {
                if let Some(main) = CFRunLoop::main() {
                    main.stop();
                }
            });
        });
    if let Err(error) = spawned {
        panic!("could not start the server thread: {error}");
    }
    HOSTED.store(true, Ordering::SeqCst);
    // A run loop without sources returns at once.
    // SAFETY: the callout ignores its arguments and there is no context.
    let keep_alive = unsafe {
        CFRunLoopTimer::new(
            None,
            1.0e12,
            1.0e9,
            0,
            0,
            Some(keep_alive_fired),
            std::ptr::null_mut(),
        )
    };
    if let (Some(main), Some(timer)) = (CFRunLoop::main(), keep_alive.as_deref()) {
        // SAFETY: kCFRunLoopDefaultMode is a static CFString.
        main.add_timer(Some(timer), unsafe { kCFRunLoopDefaultMode });
    }
    loop {
        CFRunLoop::run();
        if let Some(outcome) = result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            HOSTED.store(false, Ordering::SeqCst);
            return outcome.unwrap_or_else(|panic| resume_unwind(panic));
        }
    }
}

unsafe extern "C-unwind" fn keep_alive_fired(_timer: *mut CFRunLoopTimer, _info: *mut c_void) {}

/// Whether the main run loop serves `on_main`. It does not in unit tests.
pub fn main_thread_hosted() -> bool {
    HOSTED.load(Ordering::SeqCst)
}

async fn finish<T>(
    what: &str,
    timeout: Duration,
    receiver: tokio::sync::oneshot::Receiver<std::thread::Result<Result<T, String>>>,
) -> Result<T, String> {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(result))) => result,
        Ok(Ok(Err(_))) | Ok(Err(_)) => Err(format!("{what} failed unexpectedly")),
        Err(_) => Err(format!(
            "{what} did not finish within {} seconds",
            timeout.as_secs()
        )),
    }
}

/// Runs a blocking call on its own thread, giving up after `timeout`.
pub async fn blocking<T: Send + 'static>(
    what: &str,
    timeout: Duration,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("klex-macos-desktop".into())
        .spawn(move || {
            let _ = sender.send(catch_unwind(AssertUnwindSafe(work)));
        });
    if let Err(error) = spawned {
        return Err(format!("{what} failed: {error}"));
    }
    finish(what, timeout, receiver).await
}

/// Runs a call on the main thread, or on its own thread when nothing serves
/// the main run loop.
pub async fn on_main<T: Send + 'static>(
    what: &str,
    timeout: Duration,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if !main_thread_hosted() {
        return blocking(what, timeout, work).await;
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    DispatchQueue::main().exec_async(move || {
        let _ = sender.send(catch_unwind(AssertUnwindSafe(work)));
    });
    finish(what, timeout, receiver).await
}

/// `on_main` for a synchronous caller on a worker thread.
pub fn on_main_blocking<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if !main_thread_hosted() {
        return Some(work());
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    DispatchQueue::main().exec_async(move || {
        let _ = sender.send(work());
    });
    receiver.recv_timeout(timeout).ok()
}
