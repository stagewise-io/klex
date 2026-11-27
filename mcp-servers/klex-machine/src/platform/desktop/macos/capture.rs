//! ScreenCaptureKit capture of the main display as BGRA frames. Screenshots
//! take one frame of a short-lived stream, so both paths share this code and
//! work from macOS 12.3 on.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFString, CFType};
use objc2_core_graphics::{CGMainDisplayID, kCGColorSpaceSRGB};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSError, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCFrameStatus, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamFrameInfoStatus, SCStreamOutput, SCStreamOutputType,
};

pub const MAX_DIMENSION: usize = 16_384;
const BGRA: u32 = u32::from_be_bytes(*b"BGRA");
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// One captured frame: `height` rows of `stride` bytes, BGRA pixels.
pub struct Frame<'a> {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub bytes: &'a [u8],
}

pub type OnFrame = Box<dyn FnMut(Frame<'_>) + Send>;
pub type OnStop = Box<dyn Fn(String) + Send + Sync>;

pub struct Ivars {
    on_frame: Mutex<OnFrame>,
    on_stop: OnStop,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and the class has no
    // Drop impl.
    #[unsafe(super(NSObject))]
    #[name = "KlexMachineStreamOutput"]
    #[ivars = Ivars]
    pub struct StreamOutput;

    unsafe impl NSObjectProtocol for StreamOutput {}

    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn didoutput(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            let _ = catch_unwind(AssertUnwindSafe(|| self.handle(sample, kind)));
        }
    }

    unsafe impl SCStreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            let message = error.localizedDescription().to_string();
            let _ = catch_unwind(AssertUnwindSafe(|| (self.ivars().on_stop)(message)));
        }
    }
);

impl StreamOutput {
    fn new(on_frame: OnFrame, on_stop: OnStop) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars {
            on_frame: Mutex::new(on_frame),
            on_stop,
        });
        // SAFETY: NSObject's init.
        unsafe { msg_send![super(this), init] }
    }

    fn handle(&self, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
        // SAFETY: the sample buffer is valid for the callback.
        if kind != SCStreamOutputType::Screen || !unsafe { sample.is_valid() } {
            return;
        }
        // SAFETY: as above.
        let Some(attachments) = (unsafe { sample.sample_attachments_array(false) }) else {
            return;
        };
        // SAFETY: sample attachments are dictionaries keyed by strings.
        let attachments: &CFArray<CFDictionary<CFString, CFType>> =
            unsafe { attachments.cast_unchecked() };
        // SAFETY: NSString is toll-free bridged to CFString.
        let key: &CFString =
            unsafe { &*std::ptr::from_ref::<NSString>(SCStreamFrameInfoStatus).cast() };
        let status = attachments
            .get(0)
            .and_then(|info| info.get(key))
            .and_then(|value| value.downcast_ref::<CFNumber>().and_then(CFNumber::as_i64));
        if status != Some(SCFrameStatus::Complete.0 as i64) {
            return;
        }
        // SAFETY: as above.
        let Some(buffer) = (unsafe { sample.image_buffer() }) else {
            return;
        };
        // SAFETY: a locked base address stays valid until the unlock.
        unsafe {
            if CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
                return;
            }
        }
        let base = CVPixelBufferGetBaseAddress(&buffer);
        let width = CVPixelBufferGetWidth(&buffer);
        let height = CVPixelBufferGetHeight(&buffer);
        let stride = CVPixelBufferGetBytesPerRow(&buffer);
        if !base.is_null()
            && width > 0
            && height > 0
            && width <= MAX_DIMENSION
            && height <= MAX_DIMENSION
            && stride >= width * 4
        {
            // SAFETY: a non-planar buffer holds `height` rows of `stride`.
            let bytes = unsafe { std::slice::from_raw_parts(base.cast::<u8>(), stride * height) };
            let mut on_frame = self
                .ivars()
                .on_frame
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            on_frame(Frame {
                width,
                height,
                stride,
                bytes,
            });
        }
        // SAFETY: matches the lock above.
        unsafe {
            CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly);
        }
    }
}

struct Sendable<T>(T);
// SAFETY: ScreenCaptureKit objects are used from whichever thread receives
// them, one at a time.
unsafe impl<T> Send for Sendable<T> {}

/// The capturable display matching the main display.
pub fn main_display() -> Result<Retained<SCDisplay>, String> {
    let (sender, receiver) = mpsc::channel();
    let main = CGMainDisplayID();
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: valid for the duration of the callback, or null.
            let result = match unsafe { content.as_ref() } {
                Some(content) => {
                    // SAFETY: a plain property read.
                    let displays = unsafe { content.displays() };
                    displays
                        .iter()
                        .find(|display| unsafe { display.displayID() } == main)
                        .or_else(|| displays.firstObject())
                        .map(Sendable)
                        .ok_or_else(|| "No display to capture".to_string())
                }
                None => Err(format!(
                    "Screen capture is unavailable: {}",
                    // SAFETY: as above.
                    unsafe { error.as_ref() }
                        .map(|error| error.localizedDescription().to_string())
                        .unwrap_or_else(|| "unknown error".into())
                )),
            };
            let _ = sender.send(result);
        },
    );
    // SAFETY: the handler outlives the call; ScreenCaptureKit copies it.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            false, true, &handler,
        );
    }
    match receiver.recv_timeout(SETUP_TIMEOUT) {
        Ok(result) => result.map(|display| display.0),
        Err(_) => Err("Screen capture did not list the displays in time".into()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamSettings {
    pub width: usize,
    pub height: usize,
    pub shows_cursor: bool,
    pub frames_per_second: i32,
}

fn configuration(settings: StreamSettings) -> Retained<SCStreamConfiguration> {
    // SAFETY: plain property setters on a fresh configuration.
    unsafe {
        let configuration = SCStreamConfiguration::new();
        configuration.setWidth(settings.width.clamp(1, MAX_DIMENSION));
        configuration.setHeight(settings.height.clamp(1, MAX_DIMENSION));
        configuration.setPixelFormat(BGRA);
        configuration.setMinimumFrameInterval(CMTime::new(1, settings.frames_per_second));
        configuration.setQueueDepth(3);
        configuration.setShowsCursor(settings.shows_cursor);
        configuration.setColorSpaceName(kCGColorSpaceSRGB);
        configuration
    }
}

fn wait_for(receiver: &mpsc::Receiver<Option<String>>, what: &str) -> Result<(), String> {
    match receiver.recv_timeout(SETUP_TIMEOUT) {
        Ok(None) => Ok(()),
        Ok(Some(error)) => Err(format!("{what}: {error}")),
        Err(_) => Err(format!("{what}: no answer from ScreenCaptureKit")),
    }
}

type Completion = (
    RcBlock<dyn Fn(*mut NSError)>,
    mpsc::Receiver<Option<String>>,
);

fn completion() -> Completion {
    let (sender, receiver) = mpsc::channel();
    let block = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: valid for the duration of the callback, or null.
        let error = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
        let _ = sender.send(error);
    });
    (block, receiver)
}

/// A running capture. Frames arrive on its serial queue.
pub struct Capture {
    stream: Retained<SCStream>,
    output: Retained<StreamOutput>,
    _queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: SCStream's methods may be called from any thread.
unsafe impl Send for Capture {}
// SAFETY: as above.
unsafe impl Sync for Capture {}

impl Capture {
    /// Starts capturing and waits until ScreenCaptureKit confirms it.
    pub fn start(
        display: &SCDisplay,
        settings: StreamSettings,
        queue: DispatchRetained<DispatchQueue>,
        on_frame: OnFrame,
        on_stop: OnStop,
    ) -> Result<Self, String> {
        let output = StreamOutput::new(on_frame, on_stop);
        // SAFETY: standard initializers with valid arguments.
        let stream = unsafe {
            let filter = SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                display,
                &NSArray::new(),
            );
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration(settings),
                Some(ProtocolObject::from_ref(&*output)),
            )
        };
        // SAFETY: the output and queue live as long as the capture.
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*output),
                SCStreamOutputType::Screen,
                Some(&queue),
            )
        }
        .map_err(|error| {
            format!(
                "Could not start screen capture: {}",
                error.localizedDescription()
            )
        })?;
        let (done, receiver) = completion();
        // SAFETY: ScreenCaptureKit copies the block.
        unsafe { stream.startCaptureWithCompletionHandler(Some(&done)) };
        let capture = Self {
            stream,
            output,
            _queue: queue,
        };
        if let Err(error) = wait_for(&receiver, "Could not start screen capture") {
            capture.stop();
            return Err(error);
        }
        Ok(capture)
    }

    pub fn reconfigure(&self, settings: StreamSettings) {
        // SAFETY: a fresh configuration; no completion needed.
        unsafe {
            self.stream
                .updateConfiguration_completionHandler(&configuration(settings), None);
        }
    }

    /// Frames already queued may still arrive, so the output lives until
    /// ScreenCaptureKit confirms the stop.
    pub fn stop(&self) {
        let output = std::cell::Cell::new(Some(self.output.clone()));
        let done = RcBlock::new(move |_: *mut NSError| drop(output.take()));
        // SAFETY: stopping an idle or stopped stream only reports an error;
        // ScreenCaptureKit copies the block.
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&done)) };
    }
}

/// One frame of the main display at `width` by `height` pixels, packed
/// BGRA rows. Blocking.
pub fn screenshot(
    width: usize,
    height: usize,
    timeout: Duration,
) -> Result<(usize, usize, Vec<u8>), String> {
    let display = main_display()?;
    let (sender, receiver) = mpsc::channel();
    let mut sender = Some(sender);
    let on_frame: OnFrame = Box::new(move |frame| {
        let Some(sender) = sender.take() else {
            return;
        };
        let row = frame.width * 4;
        let mut pixels = Vec::with_capacity(row * frame.height);
        for line in frame.bytes.chunks(frame.stride).take(frame.height) {
            pixels.extend_from_slice(&line[..row]);
        }
        let _ = sender.send(Ok((frame.width, frame.height, pixels)));
    });
    let (stopped, stop_receiver) = mpsc::channel();
    let on_stop: OnStop = Box::new(move |error| {
        let _ = stopped.send(error);
    });
    let capture = Capture::start(
        &display,
        StreamSettings {
            width,
            height,
            shows_cursor: false,
            frames_per_second: 30,
        },
        DispatchQueue::new("klex.screenshot", None),
        on_frame,
        on_stop,
    )?;
    let result = receiver.recv_timeout(timeout);
    capture.stop();
    match result {
        Ok(result) => result,
        Err(_) => Err(match stop_receiver.try_recv() {
            Ok(error) => format!("Screen capture stopped: {error}"),
            Err(_) => "Screen capture returned no frame".into(),
        }),
    }
}
