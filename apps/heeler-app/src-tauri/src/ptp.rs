//! PTP over USB for direct camera capture.
//!
//! The transport is nusb (Apache-2.0 OR MIT) with the PTP layer written
//! here against PIMA 15740, because the only crates.io PTP stack is
//! unmaintained and sits on the C libusb. Everything that can be
//! checked without hardware (container coding, dataset parsing, mode
//! classification, the diagnostic report) is a pure function pinned by
//! the tests at the bottom; the hardware-touching seam is kept thin and
//! logs every step, because the owner is the hardware in the loop and a
//! silent no-op is the failure this module exists to prevent.

use nusb::descriptors::TransferType;
use nusb::transfer::{Buffer, Direction};
use nusb::MaybeFuture;
use serde::Serialize;
use std::time::Duration;

// --- USB classification -------------------------------------------------

/// USB interface class for PTP/MTP still imaging devices.
pub const USB_CLASS_STILL_IMAGE: u8 = 0x06;
/// USB interface class for mass storage: a camera in card-reader mode.
pub const USB_CLASS_MASS_STORAGE: u8 = 0x08;

/// The camera families Heeler knows, one table keying detection off
/// the USB vendor id, the extension id a connected body reports, or
/// the manufacturer string. The verdict never rests on this table
/// alone (an unknown vendor with a class-6 interface is still a PTP
/// candidate); it exists so a known body in the wrong USB mode gets a
/// remedy instead of a shrug, and so the scan report can state how far
/// Heeler goes with that family today.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    Panasonic,
    Canon,
    Nikon,
    Fujifilm,
    Sony,
    OmSystem,
    Leica,
    Pentax,
    Unknown,
}

impl Family {
    pub fn from_vendor_id(vid: u16) -> Family {
        match vid {
            0x04A9 => Family::Canon,
            0x04B0 => Family::Nikon,
            0x04CB => Family::Fujifilm,
            0x04DA => Family::Panasonic,
            0x054C => Family::Sony,
            0x07B4 => Family::OmSystem,
            0x1A98 => Family::Leica,
            0x25FB => Family::Pentax,
            _ => Family::Unknown,
        }
    }

    /// The vendor extension id from GetDeviceInfo, per libgphoto2's
    /// ptp.h. A body reporting no tabled extension (plain PTP, or MTP
    /// extension 6) comes back Unknown here and the caller falls back
    /// to the manufacturer string.
    pub fn from_extension_id(ext: u32) -> Family {
        match ext {
            e if e == panasonic::VENDOR_EXTENSION => Family::Panasonic,
            e if e == canon::VENDOR_EXTENSION => Family::Canon,
            e if e == nikon::VENDOR_EXTENSION => Family::Nikon,
            e if e == fuji::VENDOR_EXTENSION => Family::Fujifilm,
            e if e == sony::VENDOR_EXTENSION => Family::Sony,
            _ => Family::Unknown,
        }
    }

    pub fn from_manufacturer(manufacturer: &str) -> Family {
        let m = manufacturer.to_lowercase();
        if m.contains("panasonic") {
            Family::Panasonic
        } else if m.contains("canon") {
            Family::Canon
        } else if m.contains("nikon") {
            Family::Nikon
        } else if m.contains("fuji") {
            Family::Fujifilm
        } else if m.contains("sony") {
            Family::Sony
        } else if m.contains("olympus") || m.contains("om system") || m.contains("omdigital") {
            Family::OmSystem
        } else if m.contains("leica") {
            Family::Leica
        } else if m.contains("pentax") || m.contains("ricoh") {
            Family::Pentax
        } else {
            Family::Unknown
        }
    }

    pub fn name(self) -> Option<&'static str> {
        Some(match self {
            Family::Panasonic => "Panasonic",
            Family::Canon => "Canon",
            Family::Nikon => "Nikon",
            Family::Fujifilm => "Fujifilm",
            Family::Sony => "Sony",
            Family::OmSystem => "OM System / Olympus",
            Family::Leica => "Leica",
            Family::Pentax => "Pentax / Ricoh",
            Family::Unknown => return None,
        })
    }

    /// One honest sentence on how far Heeler goes with the family
    /// today, carried by the scan report so a bug report from a body
    /// nobody owns says what "detected" does and does not mean.
    pub fn readiness(self) -> &'static str {
        match self {
            Family::Panasonic => {
                "Panasonic: capture, exposure, live view, and focus drive verified on the DC-S5"
            }
            Family::Canon => {
                "Canon: detected only; EOS capture runs a vendor remote-mode sequence, tabled from libgphoto2 and unwired until a body verifies it"
            }
            Family::Nikon => {
                "Nikon: detected only; a body listing standard InitiateCapture uses the shared capture path, the vendor operations are tabled but unwired"
            }
            Family::Fujifilm => {
                "Fujifilm: detected only; vendor operations tabled from libgphoto2, unwired until a body verifies them"
            }
            Family::Sony => {
                "Sony: detected only; the SDIO session is a multi-phase handshake and unwired, the hardest family to bring up"
            }
            Family::OmSystem => "OM System / Olympus: detected only, standard PTP, no vendor operations tabled",
            Family::Leica => "Leica: detected only, standard PTP, no vendor operations tabled",
            Family::Pentax => "Pentax / Ricoh: detected only, standard PTP, no vendor operations tabled",
            Family::Unknown => "unknown maker: standard PTP only",
        }
    }
}

pub fn camera_vendor_name(vid: u16) -> Option<&'static str> {
    Family::from_vendor_id(vid).name()
}

/// What one enumerated device means for tethering, with the remedy when
/// the answer is a mode problem rather than an absence.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub enum CameraVerdict {
    /// A class-6 interface is present: PTP is reachable.
    PtpCapable,
    /// A known camera presenting only mass storage: the body's USB mode
    /// is set to card reader, and no PTP interface exists until the
    /// mode changes on the camera.
    MassStorageOnly,
    /// A known camera with neither imaging nor storage on show.
    KnownCameraNoImaging,
    /// No reason to think this is a camera at all.
    NotCamera,
}

impl CameraVerdict {
    pub fn note(self) -> &'static str {
        match self {
            CameraVerdict::PtpCapable => "PTP interface present; ready to connect",
            CameraVerdict::MassStorageOnly => {
                "Camera is in card-reader mode. On the body, switch the USB mode to PTP / PC Remote / tether, then Refresh."
            }
            CameraVerdict::KnownCameraNoImaging => {
                "Known camera maker but no imaging interface on show. Check the USB mode on the body, then Refresh."
            }
            CameraVerdict::NotCamera => "Not a camera",
        }
    }
}

pub fn classify(vid: u16, interface_classes: &[u8]) -> CameraVerdict {
    if interface_classes.contains(&USB_CLASS_STILL_IMAGE) {
        return CameraVerdict::PtpCapable;
    }
    if camera_vendor_name(vid).is_some() {
        if interface_classes.contains(&USB_CLASS_MASS_STORAGE) {
            return CameraVerdict::MassStorageOnly;
        }
        return CameraVerdict::KnownCameraNoImaging;
    }
    CameraVerdict::NotCamera
}

/// One enumerated USB device, reduced to what the panel and the bug
/// report need.
#[derive(Clone, Serialize)]
pub struct CameraProbe {
    /// Match key for connect: vid, pid, bus, and address, stable for
    /// the lifetime of the app run.
    pub key: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub name: String,
    pub manufacturer: Option<String>,
    pub serial: Option<String>,
    pub verdict: CameraVerdict,
    pub note: String,
    /// Every interface class the device presents. A tether body can
    /// show the card alongside the PTP interface (Panasonic bodies are
    /// suspected of this); the verdict names the first match, so the
    /// full list is what settles what the body actually offers.
    pub interfaces: Vec<u8>,
}

/// Enumerate the bus and reduce it to camera-shaped devices. Nothing
/// camera-shaped still produces a report line: the panel must be able
/// to say what was seen, not stay silent.
pub fn probe_cameras() -> (Vec<CameraProbe>, usize) {
    let devices: Vec<nusb::DeviceInfo> = match nusb::list_devices().wait() {
        Ok(iter) => iter.collect(),
        Err(_) => return (Vec::new(), 0),
    };
    let total = devices.len();
    let probes = devices
        .iter()
        .filter_map(|info| {
            let vid = info.vendor_id();
            let pid = info.product_id();
            let classes: Vec<u8> = info.interfaces().map(|i| i.class()).collect();
            let verdict = classify(vid, &classes);
            if verdict == CameraVerdict::NotCamera {
                return None;
            }
            let name = info
                .product_string()
                .map(|s| s.to_string())
                .or_else(|| camera_vendor_name(vid).map(|v| format!("{v} camera")))
                .unwrap_or_else(|| "PTP device".to_string());
            let key = format!(
                "{vid:04x}:{pid:04x}:{}:{}",
                info.bus_id(),
                info.device_address()
            );
            Some(CameraProbe {
                key,
                vendor_id: vid,
                product_id: pid,
                name,
                manufacturer: info.manufacturer_string().map(|s| s.to_string()),
                serial: info.serial_number().map(|s| s.to_string()),
                verdict,
                note: verdict.note().to_string(),
                interfaces: classes,
            })
        })
        .collect();
    (probes, total)
}

/// The plain-language scan report behind the panel's copy-diagnostics
/// button: what was looked for, what the bus held, and what each
/// camera-shaped device means. A community bug report for a body
/// nobody owns starts from this text.
pub fn diagnostic_report(probes: &[CameraProbe], total: usize, extra: &[String]) -> String {
    let mut lines = vec![
        "Heeler USB camera scan".to_string(),
        "Transport: nusb (Apache-2.0 OR MIT), PTP per PIMA 15740.".to_string(),
        "Looking for: USB class 6 (still image / PTP) interfaces.".to_string(),
        format!(
            "{total} USB device{suffix} on the bus; {cameras} camera-shaped.",
            suffix = if total == 1 { "" } else { "s" },
            cameras = probes.len()
        ),
    ];
    if probes.is_empty() {
        lines.push(
            "No camera-shaped device seen. Check the cable, that the body is on, and that its USB mode offers PTP / PC Remote rather than charging or card reader."
                .to_string(),
        );
    }
    for p in probes {
        lines.push(format!(
            "{:04x}:{:04x} {} {}",
            p.vendor_id,
            p.product_id,
            p.name,
            p.serial.as_deref().map(|s| format!("serial {s}")).unwrap_or_default()
        ));
        lines.push(format!("  verdict: {:?}: {}", p.verdict, p.note));
        lines.push(format!(
            "  interfaces: {}",
            p.interfaces
                .iter()
                .map(|c| match c {
                        6 => "6 (still image / PTP)".to_string(),
                        8 => "8 (mass storage / card)".to_string(),
                        other => format!("{other}"),
                    })
                .collect::<Vec<_>>()
                .join(", ")
        ));
        let family = Family::from_vendor_id(p.vendor_id);
        if family != Family::Unknown {
            lines.push(format!("  family: {}", family.readiness()));
        }
    }
    if cfg!(target_os = "macos") {
        lines.push(
            "macOS note: if Connect fails with a busy or access error, quit Photos and Image Capture; macOS claims cameras for its own capture daemon."
                .to_string(),
        );
    }
    if cfg!(target_os = "linux") {
        lines.push(
            "Linux note: a permission error on Connect usually means udev rules; the device node must be writable by the user."
                .to_string(),
        );
    }
    if cfg!(target_os = "windows") {
        lines.push(
            "Windows note: the camera binds to the OS PTP driver, which user software cannot claim. Install the WinUSB driver for the camera with Zadig (per camera, persistent across reboots), then Connect. The steps, the trade, and how to undo it: Help > User Documentation > Connecting a camera over USB."
                .to_string(),
        );
    }
    lines.extend(extra.iter().cloned());
    lines.join("\n")
}

// --- PTP protocol coding ------------------------------------------------

pub mod op {
    pub const GET_DEVICE_INFO: u16 = 0x1001;
    pub const OPEN_SESSION: u16 = 0x1002;
    pub const CLOSE_SESSION: u16 = 0x1003;
    pub const GET_OBJECT_HANDLES: u16 = 0x1007;
    pub const GET_OBJECT_INFO: u16 = 0x1008;
    pub const GET_OBJECT: u16 = 0x1009;
    pub const INITIATE_CAPTURE: u16 = 0x100E;
    pub const GET_DEVICE_PROP_DESC: u16 = 0x1014;
    pub const GET_DEVICE_PROP_VALUE: u16 = 0x1015;
}

pub mod rsp {
    pub const OK: u16 = 0x2001;
    pub const GENERAL_ERROR: u16 = 0x2002;
    pub const SESSION_NOT_OPEN: u16 = 0x2003;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x2005;
    pub const DEVICE_BUSY: u16 = 0x2019;
    pub const SESSION_ALREADY_OPEN: u16 = 0x201E;
}

pub mod event {
    pub const OBJECT_ADDED: u16 = 0x4002;
    pub const CAPTURE_COMPLETE: u16 = 0x400D;
}

/// Panasonic tether, per libgphoto2's ptp.h: a body reporting vendor
/// extension 0x1C hides its capture operation from the GetDeviceInfo
/// list. 0x9404 with parameter 0x03000011 is the remote release, the
/// frame announces itself with the vendor ObjectAdded events, and
/// mid-capture event 0xC101 expects a 0x9401 reply or some bodies
/// stall before announcing the frame.
pub mod panasonic {
    pub const VENDOR_EXTENSION: u32 = 0x1C;
    pub const OP_INITIATE_CAPTURE: u16 = 0x9404;
    pub const OP_EVENT_ACK: u16 = 0x9401;
    pub const CAPTURE_PARAM: u32 = 0x0300_0011;
    pub const EV_QUERY: u16 = 0xC101;
    /// The body's answer to an AF one-shot, seen live on the DC-S5
    /// (2026-08-26): after 0x9405 accepts 0x03000024 and the lens
    /// sweeps, 0xC104 arrives on the interrupt pipe before the routine
    /// 0xC101 queries resume. ptp.h lists 0xC104 under other vendors
    /// (Nikon PreviewImageAdded, Olympus DirectStoreImage_New), so the
    /// meaning here stays scoped to Panasonic.
    pub const EV_AF_RESULT: u16 = 0xC104;
    pub const EV_BUSY: u16 = 0xC107;
    pub const EV_OBJECT_ADDED: u16 = 0xC108;
    pub const EV_OBJECT_ADDED_SDRAM: u16 = 0xC109;
    /// The vendor property channel, per libgphoto2's ptp.c: 0x9402
    /// reads a value, 0x9108 returns the descriptor (current value plus
    /// the accepted list), 0x9403 writes to the _Param codes.
    pub const OP_GET_PROPERTY: u16 = 0x9402;
    pub const OP_SET_PROPERTY: u16 = 0x9403;
    pub const OP_LIST_PROPERTY: u16 = 0x9108;
    /// Live view (phase 3), per libgphoto2's Panasonic preview branch:
    /// 0x9412 starts and stops the stream, 0x9706 returns one frame
    /// (a header followed by a JPEG).
    pub const OP_LIVEVIEW: u16 = 0x9412;
    pub const OP_LIVEVIEW_IMAGE: u16 = 0x9706;
    pub const LIVEVIEW_START: u32 = 0x0D00_0010;
    pub const LIVEVIEW_STOP: u32 = 0x0D00_0011;
    /// Manual focus drive (per libgphoto2's ptp.c): 0x9416 is a data-out
    /// operation whose payload is the control code 0x03010011, a type
    /// word of 2, and the mode. gphoto's confirmed modes: 0 stop,
    /// 1 far fast, 2 far slow, 3 near slow, 4 near fast. Whether the
    /// body honors finer steps is the probe test's question.
    pub const OP_FOCUS_DRIVE: u16 = 0x9416;
    pub const FOCUS_CONTROL: u32 = 0x0301_0011;
    pub const FOCUS_STOP: u16 = 0;
    /// "Rec Ctrl AF AE" per ptp.h; gphoto declares it but never calls
    /// it, so the parameter is unproven until the probe run says.
    pub const OP_AF_AE: u16 = 0x9405;

    /// The AF/AE command family, declared in libgphoto2's ptp.h as
    /// property codes but never exercised there: 0x03000020 is the
    /// command base, 0x03000024 is AF one-shot. Probe run 5 (DC-S5,
    /// 2026-08-26) settled the family: the descriptor is not listable
    /// and the property channel refuses the writes, but 0x9405 with
    /// 0x03000024 as its parameter runs a real AF sweep (lens moved,
    /// event 0xC104 followed). The command base stays refused.
    pub mod af {
        pub const CMD_BASE: u32 = 0x0300_0020;
        pub const AF_ONE_SHOT: u32 = 0x0300_0024;
    }

    /// Panasonic settings are 32-bit vendor codes, not the standard
    /// 16-bit device properties. Writes go to the _Param codes.
    pub mod prop {
        pub const ISO: u32 = 0x0200_0020;
        pub const ISO_PARAM: u32 = 0x0200_0021;
        pub const SHUTTER_SPEED: u32 = 0x0200_0030;
        pub const SHUTTER_SPEED_PARAM: u32 = 0x0200_0031;
        pub const APERTURE: u32 = 0x0200_0040;
        pub const APERTURE_PARAM: u32 = 0x0200_0041;
        pub const WHITE_BALANCE: u32 = 0x0200_0050;
        pub const WHITE_BALANCE_PARAM: u32 = 0x0200_0051;
    }
}

/// Canon EOS tether, transcribed from libgphoto2's ptp.h. EOS capture
/// is a sequence, not one operation: remote mode on (0x9114), event
/// mode on (0x9115), then release (0x910F, or the half-press pair
/// 0x9128/0x9129), and frames announce over the 0x9116 event channel
/// rather than the card watch. Properties go through 0x9110 and must
/// be re-requested with 0x9127 after the body changes them. None of
/// this is wired; the table exists so a Canon body on the bench starts
/// from sourced constants instead of guesswork.
pub mod canon {
    pub const VENDOR_EXTENSION: u32 = 0x0B;
    pub const OP_REMOTE_RELEASE: u16 = 0x910F;
    pub const OP_SET_DEVICE_PROP_VALUE_EX: u16 = 0x9110;
    pub const OP_SET_REMOTE_MODE: u16 = 0x9114;
    pub const OP_SET_EVENT_MODE: u16 = 0x9115;
    pub const OP_GET_EVENT: u16 = 0x9116;
    pub const OP_REQUEST_DEVICE_PROP_VALUE: u16 = 0x9127;
    pub const OP_REMOTE_RELEASE_ON: u16 = 0x9128;
    pub const OP_REMOTE_RELEASE_OFF: u16 = 0x9129;
    pub const OP_INITIATE_VIEWFINDER: u16 = 0x9151;
    pub const OP_TERMINATE_VIEWFINDER: u16 = 0x9152;
    pub const OP_GET_VIEWFINDER_DATA: u16 = 0x9153;
    pub const OP_DO_AF: u16 = 0x9154;
    pub const OP_DRIVE_LENS: u16 = 0x9155;
}

/// Nikon tether, transcribed from libgphoto2's ptp.h. Bodies that list
/// the standard InitiateCapture use the shared capture path already;
/// the vendor operations here cover SDRAM capture, the event poll,
/// live view, and focus drive for the bodies that hide the standard
/// operation. Tabled, unwired, unverified.
pub mod nikon {
    pub const VENDOR_EXTENSION: u32 = 0x0A;
    pub const OP_INITIATE_CAPTURE_REC_IN_SDRAM: u16 = 0x90C0;
    pub const OP_AF_DRIVE: u16 = 0x90C1;
    pub const OP_GET_EVENT: u16 = 0x90C7;
    pub const OP_DEVICE_READY: u16 = 0x90C8;
    pub const OP_START_LIVEVIEW: u16 = 0x9201;
    pub const OP_END_LIVEVIEW: u16 = 0x9202;
    pub const OP_GET_LIVEVIEW_IMG: u16 = 0x9203;
    pub const OP_MF_DRIVE: u16 = 0x9204;
    pub const OP_INITIATE_CAPTURE_REC_IN_MEDIA: u16 = 0x9207;
}

/// Fujifilm tether, transcribed from libgphoto2's ptp.h. gphoto's Fuji
/// coverage is thin next to Canon and Nikon: a preview fetch, the
/// focus point lock pair, and the stepping setters. Tabled, unwired,
/// unverified.
pub mod fuji {
    pub const VENDOR_EXTENSION: u32 = 0x0E;
    pub const OP_GET_CAPTURE_PREVIEW: u16 = 0x9022;
    pub const OP_SET_FOCUS_POINT: u16 = 0x9026;
    pub const OP_RESET_FOCUS_POINT: u16 = 0x9027;
    pub const OP_SET_SHUTTER_SPEED: u16 = 0x902C;
    pub const OP_SET_APERTURE: u16 = 0x902D;
    pub const OP_SET_EXPOSURE_COMPENSATION: u16 = 0x902E;
}

/// Sony tether, transcribed from libgphoto2's ptp.h. The SDIO session
/// is a multi-phase handshake (0x9201 connect in stages, then 0x9210)
/// that gphoto negotiates before any property or capture operation
/// answers, which makes Sony the hardest family to bring up. Tabled,
/// unwired, unverified.
pub mod sony {
    pub const VENDOR_EXTENSION: u32 = 0x11;
    pub const OP_SDIO_CONNECT: u16 = 0x9201;
    pub const OP_SDIO_GET_EXT_DEVICE_INFO: u16 = 0x9202;
    pub const OP_SDIO_SET_EXT_DEVICE_PROP_VALUE: u16 = 0x9205;
    pub const OP_SDIO_CONTROL_DEVICE: u16 = 0x9207;
    pub const OP_SDIO_OPEN_SESSION: u16 = 0x9210;
}

/// Remote shutter availability: the standard operation, or a
/// Panasonic tether body, whose capture operation is real but absent
/// from the reported list (libgphoto2 hard-codes the same vendor
/// operations for this family, product 0x2382 among them).
pub fn can_capture(info: &DeviceInfo) -> bool {
    info.operations.contains(&op::INITIATE_CAPTURE)
        || info.vendor_extension_id == panasonic::VENDOR_EXTENSION
}

/// The connected body as a family. The extension id is the stronger
/// signal; a body reporting a plain or MTP extension falls back to
/// the manufacturer string so a Lumix in a non-tether mode still gets
/// Lumix advice.
pub fn device_family(info: &DeviceInfo) -> Family {
    match Family::from_extension_id(info.vendor_extension_id) {
        Family::Unknown => Family::from_manufacturer(&info.manufacturer),
        f => f,
    }
}

/// The connect-time note when the body offers no capture operation
/// Heeler can call, per family: the remedy where one exists on the
/// body, and the honest unwired status where the vendor capture path
/// is tabled but hardware has not verified it. A family with no wired
/// capture path keeps the capture button off; this note is what the
/// shooter gets instead of a dead control.
pub fn no_capture_note(info: &DeviceInfo) -> String {
    match device_family(info) {
        Family::Panasonic => {
            "NOTE: the body does not offer remote capture in its current mode. On Lumix bodies, pick the PC tether / PC Remote USB mode on the camera.".to_string()
        }
        Family::Canon => {
            "NOTE: EOS bodies hide capture behind the vendor remote-mode sequence (0x9114, then 0x910F); that path is tabled but unwired until a Canon body verifies it.".to_string()
        }
        Family::Nikon => {
            "NOTE: the body does not list InitiateCapture; Nikon's vendor capture operations (0x90C0, 0x9207) are tabled but unwired until a Nikon body verifies them.".to_string()
        }
        Family::Fujifilm => {
            "NOTE: the body does not list InitiateCapture; Fujifilm's vendor operations are tabled but unwired until a Fujifilm body verifies them.".to_string()
        }
        Family::Sony => {
            "NOTE: Sony bodies need the SDIO handshake (0x9201 stages, then 0x9210) before any capture operation answers; that handshake is unwired.".to_string()
        }
        _ => {
            "NOTE: the body does not offer remote capture in its current mode; check the USB mode on the camera.".to_string()
        }
    }
}

/// Panasonic property writes go to the _Param code, reads to the base
/// code. An unknown base gets no write code at all: only the settings
/// phase 2 exposes are writable.
pub fn panasonic_write_code(base: u32) -> Option<u32> {
    use panasonic::prop as p;
    Some(match base {
        p::ISO => p::ISO_PARAM,
        p::SHUTTER_SPEED => p::SHUTTER_SPEED_PARAM,
        p::APERTURE => p::APERTURE_PARAM,
        p::WHITE_BALANCE => p::WHITE_BALANCE_PARAM,
        _ => return None,
    })
}

/// ObjectInfo format 0x3001: an association, i.e. a folder. Cameras
/// announce a newly created DCIM folder over ObjectAdded just like a
/// frame, and fetching one stalls the pipe, so every arrival path
/// must refuse it.
const FORMAT_ASSOCIATION: u16 = 0x3001;

/// The response code in words, so a camera's refusal reads as a reason.
pub fn response_meaning(code: u16) -> String {
    match code {
        rsp::OK => "ok".to_string(),
        rsp::GENERAL_ERROR => "general error".to_string(),
        rsp::SESSION_NOT_OPEN => "session not open".to_string(),
        rsp::OPERATION_NOT_SUPPORTED => "the camera does not support that operation".to_string(),
        rsp::DEVICE_BUSY => "camera busy".to_string(),
        0x201D => "invalid parameter".to_string(),
        rsp::SESSION_ALREADY_OPEN => "session already open".to_string(),
        other => format!("response 0x{other:04X}"),
    }
}

pub fn operation_name(code: u16) -> String {
    match code {
        op::GET_DEVICE_INFO => "GetDeviceInfo".to_string(),
        op::OPEN_SESSION => "OpenSession".to_string(),
        op::CLOSE_SESSION => "CloseSession".to_string(),
        op::GET_OBJECT_HANDLES => "GetObjectHandles".to_string(),
        op::GET_OBJECT_INFO => "GetObjectInfo".to_string(),
        op::GET_OBJECT => "GetObject".to_string(),
        op::INITIATE_CAPTURE => "InitiateCapture".to_string(),
        op::GET_DEVICE_PROP_DESC => "GetDevicePropDesc".to_string(),
        op::GET_DEVICE_PROP_VALUE => "GetDevicePropValue".to_string(),
        0x9102 => "Panasonic vendor session open".to_string(),
        0x9103 => "Panasonic vendor session close".to_string(),
        panasonic::OP_LIST_PROPERTY => "Panasonic ListProperty".to_string(),
        panasonic::OP_GET_PROPERTY => "Panasonic GetProperty".to_string(),
        panasonic::OP_SET_PROPERTY => "Panasonic SetProperty".to_string(),
        panasonic::OP_INITIATE_CAPTURE => "Panasonic InitiateCapture".to_string(),
        panasonic::OP_LIVEVIEW => "Panasonic LiveView start/stop".to_string(),
        panasonic::OP_LIVEVIEW_IMAGE => "Panasonic LiveviewImage".to_string(),
        panasonic::OP_FOCUS_DRIVE => "Panasonic ManualFocusDrive".to_string(),
        panasonic::OP_AF_AE => "Panasonic AF/AE control".to_string(),
        other => format!("0x{other:04X}"),
    }
}

/// Operation names with the connected body's family applied first.
/// The vendor code space overlaps across families (0x9102 is a
/// Panasonic session verb and Canon's EOS GetStorageInfo), so the
/// family settles which table a hex code reads against; codes outside
/// the family's tabled set fall through to the shared names and then
/// to hex.
pub fn operation_name_for(family: Family, code: u16) -> String {
    let named: Option<&str> = match family {
        Family::Canon => Some(match code {
            canon::OP_REMOTE_RELEASE => "Canon EOS RemoteRelease",
            canon::OP_SET_DEVICE_PROP_VALUE_EX => "Canon EOS SetDevicePropValueEx",
            canon::OP_SET_REMOTE_MODE => "Canon EOS SetRemoteMode",
            canon::OP_SET_EVENT_MODE => "Canon EOS SetEventMode",
            canon::OP_GET_EVENT => "Canon EOS GetEvent",
            canon::OP_REQUEST_DEVICE_PROP_VALUE => "Canon EOS RequestDevicePropValue",
            canon::OP_REMOTE_RELEASE_ON => "Canon EOS RemoteReleaseOn",
            canon::OP_REMOTE_RELEASE_OFF => "Canon EOS RemoteReleaseOff",
            canon::OP_INITIATE_VIEWFINDER => "Canon EOS InitiateViewfinder",
            canon::OP_TERMINATE_VIEWFINDER => "Canon EOS TerminateViewfinder",
            canon::OP_GET_VIEWFINDER_DATA => "Canon EOS GetViewFinderData",
            canon::OP_DO_AF => "Canon EOS DoAf",
            canon::OP_DRIVE_LENS => "Canon EOS DriveLens",
            _ => return operation_name(code),
        }),
        Family::Nikon => Some(match code {
            nikon::OP_INITIATE_CAPTURE_REC_IN_SDRAM => "Nikon InitiateCaptureRecInSdram",
            nikon::OP_AF_DRIVE => "Nikon AfDrive",
            nikon::OP_GET_EVENT => "Nikon GetEvent",
            nikon::OP_DEVICE_READY => "Nikon DeviceReady",
            nikon::OP_START_LIVEVIEW => "Nikon StartLiveView",
            nikon::OP_END_LIVEVIEW => "Nikon EndLiveView",
            nikon::OP_GET_LIVEVIEW_IMG => "Nikon GetLiveViewImg",
            nikon::OP_MF_DRIVE => "Nikon MfDrive",
            nikon::OP_INITIATE_CAPTURE_REC_IN_MEDIA => "Nikon InitiateCaptureRecInMedia",
            _ => return operation_name(code),
        }),
        Family::Fujifilm => Some(match code {
            fuji::OP_GET_CAPTURE_PREVIEW => "Fujifilm GetCapturePreview",
            fuji::OP_SET_FOCUS_POINT => "Fujifilm SetFocusPoint",
            fuji::OP_RESET_FOCUS_POINT => "Fujifilm ResetFocusPoint",
            fuji::OP_SET_SHUTTER_SPEED => "Fujifilm SetShutterSpeed",
            fuji::OP_SET_APERTURE => "Fujifilm SetAperture",
            fuji::OP_SET_EXPOSURE_COMPENSATION => "Fujifilm SetExposureCompensation",
            _ => return operation_name(code),
        }),
        Family::Sony => Some(match code {
            sony::OP_SDIO_CONNECT => "Sony SDIO Connect",
            sony::OP_SDIO_GET_EXT_DEVICE_INFO => "Sony SDIO GetExtDeviceInfo",
            sony::OP_SDIO_SET_EXT_DEVICE_PROP_VALUE => "Sony SDIO SetExtDevicePropValue",
            sony::OP_SDIO_CONTROL_DEVICE => "Sony SDIO ControlDevice",
            sony::OP_SDIO_OPEN_SESSION => "Sony SDIO OpenSession",
            _ => return operation_name(code),
        }),
        _ => None,
    };
    match named {
        Some(n) => n.to_string(),
        None => operation_name(code),
    }
}

/// Event codes in words where they matter to tethering; the rest stay
/// hex, which is exactly what a bug report needs.
pub fn event_name(code: u16) -> String {
    match code {
        event::OBJECT_ADDED => "ObjectAdded".to_string(),
        event::CAPTURE_COMPLETE => "CaptureComplete".to_string(),
        panasonic::EV_QUERY => "Panasonic query 0xC101".to_string(),
        panasonic::EV_AF_RESULT => "Panasonic AF result".to_string(),
        panasonic::EV_OBJECT_ADDED => "Panasonic ObjectAdded".to_string(),
        panasonic::EV_OBJECT_ADDED_SDRAM => "Panasonic ObjectAddedSDRAM".to_string(),
        other => format!("0x{other:04X}"),
    }
}

/// Device property codes in words where the standard names them; vendor
/// codes stay hex, which is exactly what a bug report needs.
pub fn property_name(code: u16) -> String {
    match code {
        0x5001 => "BatteryLevel",
        0x5002 => "FunctionalMode",
        0x5003 => "ImageSize",
        0x5004 => "CompressionSetting",
        0x5005 => "WhiteBalance",
        0x5007 => "FNumber",
        0x5008 => "FocalLength",
        0x500A => "FocusMode",
        0x500B => "ExposureMeteringMode",
        0x500C => "FlashMode",
        0x500D => "ExposureTime",
        0x500E => "ExposureProgramMode",
        0x500F => "ExposureIndex",
        0x5010 => "ExposureBiasCompensation",
        0x5011 => "DateTime",
        0x5013 => "StillCaptureMode",
        0x5018 => "BurstNumber",
        0x5019 => "BurstInterval",
        0x501C => "FocusMeteringMode",
        other => return format!("0x{other:04X}"),
    }
    .to_string()
}

const CONTAINER_COMMAND: u16 = 1;
const CONTAINER_DATA: u16 = 2;
const CONTAINER_RESPONSE: u16 = 3;
const CONTAINER_EVENT: u16 = 4;

/// One PTP container, decoded. Payload is the bytes past the parameter
/// block (data and event containers carry datasets there).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Container {
    pub kind: u16,
    pub code: u16,
    pub transaction: u32,
    pub params: Vec<u32>,
    pub payload: Vec<u8>,
}

/// Encode a command or data container: u32 length, u16 type, u16 code,
/// u32 transaction id, then u32 parameters, all little-endian.
pub fn encode_container(kind: u16, code: u16, transaction: u32, params: &[u32], payload: &[u8]) -> Vec<u8> {
    let len = 12 + params.len() * 4 + payload.len();
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&code.to_le_bytes());
    out.extend_from_slice(&transaction.to_le_bytes());
    for p in params {
        out.extend_from_slice(&p.to_le_bytes());
    }
    out.extend_from_slice(payload);
    out
}

/// Decode whatever the bulk-in pipe delivered into one container. The
/// length field is trusted over the byte count: a transfer can pad to
/// its packet size.
pub fn decode_container(bytes: &[u8]) -> Result<Container, String> {
    if bytes.len() < 12 {
        return Err(format!("PTP container of {} bytes, header needs 12", bytes.len()));
    }
    let len = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    if len < 12 || len > bytes.len() {
        return Err(format!(
            "PTP container declares {len} bytes, {} received",
            bytes.len()
        ));
    }
    let kind = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
    let code = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
    let transaction = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let param_count = (len - 12) / 4;
    // Parameters come in fours; a dataset (a data or event container's
    // payload) starts where the parameters stop making sense. For the
    // commands this code issues the split is fixed by the operation:
    // responses and events carry parameters, data containers carry a
    // payload. Anything else keeps both halves so nothing is lost.
    let mut params = Vec::new();
    let mut cursor = 12;
    if matches!(kind, CONTAINER_RESPONSE | CONTAINER_EVENT) {
        for _ in 0..param_count.min(5) {
            params.push(u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap()));
            cursor += 4;
        }
    }
    Ok(Container {
        kind,
        code,
        transaction,
        params,
        payload: bytes[cursor..len].to_vec(),
    })
}

fn rd_u16(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
        .ok_or_else(|| format!("dataset truncated at offset {at}"))
}

fn rd_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .ok_or_else(|| format!("dataset truncated at offset {at}"))
}

/// A PTP string: one length byte (character count including the
/// terminator), then that many UTF-16LE characters. Returns the text
/// and the offset past the field.
fn rd_string(bytes: &[u8], at: usize) -> Result<(String, usize), String> {
    let count = *bytes
        .get(at)
        .ok_or_else(|| format!("dataset truncated at offset {at}"))? as usize;
    if count == 0 {
        return Ok((String::new(), at + 1));
    }
    let mut chars = Vec::with_capacity(count);
    for i in 0..count {
        chars.push(rd_u16(bytes, at + 1 + i * 2)?);
    }
    // The count includes a trailing NUL when one is there.
    if chars.last() == Some(&0) {
        chars.pop();
    }
    Ok((
        String::from_utf16_lossy(&chars),
        at + 1 + count * 2,
    ))
}

/// A PTP u16 array: u32 count, then that many u16 values.
fn rd_u16_array(bytes: &[u8], at: usize) -> Result<(Vec<u16>, usize), String> {
    let count = rd_u32(bytes, at)? as usize;
    let mut values = Vec::with_capacity(count);
    for i in 0..count {
        values.push(rd_u16(bytes, at + 4 + i * 2)?);
    }
    Ok((values, at + 4 + count * 2))
}

/// What the body says it is and can do. The property list is read even
/// though this phase exposes no controls for it: the diagnostic report
/// is what the next phase gets built against.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DeviceInfo {
    pub standard_version: u16,
    pub vendor_extension_id: u32,
    pub vendor_extension_desc: String,
    pub operations: Vec<u16>,
    pub events: Vec<u16>,
    pub properties: Vec<u16>,
    pub capture_formats: Vec<u16>,
    pub image_formats: Vec<u16>,
    pub manufacturer: String,
    pub model: String,
    pub device_version: String,
    pub serial: String,
}

/// Parse the GetDeviceInfo dataset (PIMA 15740 section 5.1.1).
pub fn parse_device_info(bytes: &[u8]) -> Result<DeviceInfo, String> {
    let mut info = DeviceInfo {
        standard_version: rd_u16(bytes, 0)?,
        vendor_extension_id: rd_u32(bytes, 2)?,
        ..Default::default()
    };
    let (desc, mut at) = rd_string(bytes, 8)?;
    info.vendor_extension_desc = desc;
    at += 2; // FunctionalMode, unused here
    let (operations, at) = rd_u16_array(bytes, at)?;
    info.operations = operations;
    let (events, at) = rd_u16_array(bytes, at)?;
    info.events = events;
    let (properties, at) = rd_u16_array(bytes, at)?;
    info.properties = properties;
    let (capture_formats, at) = rd_u16_array(bytes, at)?;
    info.capture_formats = capture_formats;
    let (image_formats, at) = rd_u16_array(bytes, at)?;
    info.image_formats = image_formats;
    let (manufacturer, at) = rd_string(bytes, at)?;
    info.manufacturer = manufacturer;
    let (model, at) = rd_string(bytes, at)?;
    info.model = model;
    let (device_version, at) = rd_string(bytes, at)?;
    info.device_version = device_version;
    let (serial, _) = rd_string(bytes, at)?;
    info.serial = serial;
    Ok(info)
}

/// The object format out of a GetObjectInfo dataset (PIMA 15740
/// section 5.3.1): storage id (4 bytes), then the format code. This is
/// how a folder (0x3001 association) is told apart from a frame
/// before anyone tries to fetch it.
pub fn parse_object_info_format(bytes: &[u8]) -> Option<u16> {
    rd_u16(bytes, 4).ok()
}

/// A Panasonic property descriptor: the body's current value and the
/// list of values it accepts right now. The list, never a hard-coded
/// table, is what a control offers; a body in an auto mode answers a
/// different list than in M.
#[derive(Clone, Debug, PartialEq)]
pub struct PropertyDesc {
    pub code: u32,
    pub value_size: u16,
    pub current: u32,
    pub allowed: Vec<u32>,
}

/// A 0x9402 GetProperty response, per libgphoto2's ptp.c: u32 header,
/// u32 value size, then the value (2 or 4 bytes).
pub fn parse_property_value(bytes: &[u8]) -> Result<(u16, u32), String> {
    if bytes.len() < 8 {
        return Err(format!(
            "property value of {} bytes, header needs 8",
            bytes.len()
        ));
    }
    let size = rd_u32(bytes, 4)? as u16;
    let value = match size {
        2 => rd_u16(bytes, 8)? as u32,
        4 => rd_u32(bytes, 8)?,
        other => return Err(format!("property value size {other} is not 2 or 4 bytes")),
    };
    Ok((size, value))
}

/// A 0x9403 SetProperty data phase, mirroring the GetProperty answer:
/// propcode u32, value size u32, then the value at offset 8. The body
/// reads the value at that fixed offset; a tighter packing lands it
/// two bytes early and the body reads zero (on the DC-S5 that meant
/// ISO and white balance jumping to auto and shutter clamping to 1 s).
pub fn encode_set_property_payload(code: u32, value_size: u16, value: u32) -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(8 + value_size as usize);
    payload.extend_from_slice(&code.to_le_bytes());
    payload.extend_from_slice(&(value_size as u32).to_le_bytes());
    match value_size {
        2 => payload.extend_from_slice(&(value as u16).to_le_bytes()),
        4 => payload.extend_from_slice(&value.to_le_bytes()),
        other => return Err(format!("property value size {other} is not 2 or 4 bytes")),
    }
    Ok(payload)
}

/// A 0x9416 ManualFocusDrive data phase, per libgphoto2's
/// ptp_panasonic_manualfocusdrive: control code u32, a type word of 2
/// as u32, then the mode as u16 at offset 8 (the same fixed-offset
/// layout the property channel uses).
pub fn encode_focus_drive_payload(mode: u16) -> Vec<u8> {
    let mut payload = Vec::with_capacity(10);
    payload.extend_from_slice(&panasonic::FOCUS_CONTROL.to_le_bytes());
    payload.extend_from_slice(&2u32.to_le_bytes());
    payload.extend_from_slice(&mode.to_le_bytes());
    payload
}

/// Tether traces: u32 block count, u32 header length measured in u32s,
/// the property code at offset 28; then at header_len*4 + 8 the
/// current value, then the u32 count of accepted values, then the
/// values themselves, each value_size wide. The value width comes
/// from a GetProperty first, so the parse never guesses.
pub fn parse_property_desc(
    bytes: &[u8],
    code: u32,
    value_size: u16,
) -> Result<PropertyDesc, String> {
    if bytes.len() < 32 {
        return Err(format!(
            "property descriptor of {} bytes, header needs 32",
            bytes.len()
        ));
    }
    if value_size != 2 && value_size != 4 {
        return Err(format!("property value size {value_size} is not 2 or 4 bytes"));
    }
    let header_len = rd_u32(bytes, 4)? as usize;
    let at = header_len * 4 + 8;
    let width = value_size as usize;
    if bytes.len() < at + width + 4 {
        return Err(format!(
            "property descriptor of {} bytes, value and count need {}",
            bytes.len(),
            at + width + 4
        ));
    }
    let current = match value_size {
        2 => rd_u16(bytes, at)? as u32,
        _ => rd_u32(bytes, at)?,
    };
    let count = rd_u32(bytes, at + width)? as usize;
    let list_at = at + width + 4;
    let mut allowed = Vec::with_capacity(count);
    for i in 0..count {
        let off = list_at + i * width;
        if bytes.len() < off + width {
            return Err(format!(
                "property descriptor lists {count} values but carries only {i}"
            ));
        }
        allowed.push(match value_size {
            2 => rd_u16(bytes, off)? as u32,
            _ => rd_u32(bytes, off)?,
        });
    }
    Ok(PropertyDesc { code, value_size, current, allowed })
}

/// The filename out of a GetObjectInfo dataset (PIMA 15740 section
/// 5.3.1): 52 fixed bytes, then four strings of which the first is the
/// name. The rest of the dataset is the camera's business, not ours.
pub fn parse_object_info_filename(bytes: &[u8]) -> Result<String, String> {
    let (name, _) = rd_string(bytes, 52)?;
    if name.is_empty() {
        return Err("camera reported an object with no filename".to_string());
    }
    Ok(name)
}

// --- The hardware seam ----------------------------------------------------
//
// Everything below touches a device and therefore cannot be tested
// without one. It is kept deliberately thin: container coding above
// does the thinking, and every step logs so the owner's console
// tells the story of any failure.

const CMD_TIMEOUT: Duration = Duration::from_secs(5);
/// Capture can mean a long exposure before the body answers.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);

/// An open PTP session against one body.
pub struct CameraConnection {
    _device: nusb::Device,
    /// Held, never read: dropping it would release the interface claim.
    _interface: nusb::Interface,
    bulk_in: nusb::Endpoint<nusb::transfer::Bulk, nusb::transfer::In>,
    bulk_out: nusb::Endpoint<nusb::transfer::Bulk, nusb::transfer::Out>,
    event_in: Option<nusb::Endpoint<nusb::transfer::Interrupt, nusb::transfer::In>>,
    in_packet: usize,
    out_packet: usize,
    transaction: u32,
    pub info: DeviceInfo,
    /// The card's object handles as last seen. Snapshotted at connect
    /// so a card full of old photographs never imports; only frames
    /// that appear while connected count as arrivals. This is the card
    /// watch for bodies (like the DC-S5 in plain PTP mode) whose event
    /// set has no ObjectAdded to announce a shot taken on the camera.
    known_handles: Vec<u32>,
}

fn transfer_note(err: &nusb::transfer::TransferError) -> String {
    use nusb::transfer::TransferError as T;
    match err {
        T::Cancelled => "timed out (the camera did not answer in time)".to_string(),
        T::Stall => "the camera stalled the pipe; a retry usually clears it".to_string(),
        T::Disconnected => "the camera went away (cable, power, or sleep)".to_string(),
        other => format!("USB transfer failed: {other}"),
    }
}

impl CameraConnection {
    /// Open the device named by a scan key, claim its still-image
    /// interface, and open the PTP session. Every failure is a sentence
    /// with a remedy, never a bare error.
    pub fn connect<F: Fn(&str)>(key: &str, log: &F) -> Result<CameraConnection, String> {
        let devices: Vec<nusb::DeviceInfo> = nusb::list_devices()
            .wait()
            .map_err(|e| format!("cannot enumerate USB: {e}"))?
            .collect();
        let found = devices.into_iter().find(|info| {
            let classes: Vec<u8> = info.interfaces().map(|i| i.class()).collect();
            format!(
                "{:04x}:{:04x}:{}:{}",
                info.vendor_id(),
                info.product_id(),
                info.bus_id(),
                info.device_address()
            ) == key && classes.contains(&USB_CLASS_STILL_IMAGE)
        });
        let Some(info) = found else {
            return Err(
                "the device is no longer on the bus, or no longer in a PTP mode; Refresh the list"
                    .to_string(),
            );
        };
        let label = info
            .product_string()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{:04x}:{:04x}", info.vendor_id(), info.product_id()));
        log(&format!("Opening {label}"));
        let device = info.open().wait().map_err(|e| {
            let remedy = if cfg!(target_os = "macos") {
                "quit Photos and Image Capture, which claim cameras on macOS, then try again"
            } else if cfg!(target_os = "linux") {
                "check udev permissions for the device node, then try again"
            } else {
                "close any other software talking to the camera, then try again"
            };
            format!("cannot open {label}: {e}; {remedy}")
        })?;
        // The still-image interface number comes from the descriptor,
        // not a guess.
        let interface_number = info
            .interfaces()
            .find(|i| i.class() == USB_CLASS_STILL_IMAGE)
            .map(|i| i.interface_number())
            .ok_or_else(|| format!("{label} shows no still-image interface once opened"))?;
        log(&format!("Claiming interface {interface_number}"));
        let claim = device.claim_interface(interface_number).wait();
        let interface = match claim {
            Ok(i) => i,
            Err(e) => {
                let msg = format!("cannot claim the camera interface: {e}");
                // Exclusive-access on macOS is almost always ptpcamerad,
                // which launchd restarts on camera activity whether or
                // not Photos or Image Capture was ever opened, so
                // telling the user to kill it loses the race: it is back
                // before the next click. Kill it here, in the open, and
                // retry the claim once.
                let macos_exclusive = cfg!(target_os = "macos")
                    && (msg.contains("exclusive access") || msg.contains("0xe00002c5"));
                if !macos_exclusive {
                    // On Windows a camera binds to the OS PTP class driver, and nusb can only
                    // claim an interface whose driver is WinUSB, so a claim refusal there is a
                    // driver question, not busy software. Heeler ships no driver package on
                    // purpose, so this remedy is the whole Windows story and has to carry the
                    // user to the page that explains the trade and the undo.
                    if cfg!(target_os = "windows") {
                        return Err(format!(
                            "{msg}. On Windows the camera is bound to the OS PTP driver; install the WinUSB driver for the camera with Zadig (per camera, persistent), then Connect again. See Help > User Documentation > Connecting a camera over USB for the steps and how to undo it."
                        ));
                    }
                    return Err(msg);
                }
                log("macOS's PTP daemon (ptpcamerad) holds the camera; asking it to let go and retrying");
                for daemon in ["ptpcamerad", "mscamerad-xpc"] {
                    let status = std::process::Command::new("killall")
                        .args(["-9", daemon])
                        .status();
                    log(&format!("killall -9 {daemon}: {status:?}"));
                }
                std::thread::sleep(Duration::from_millis(400));
                match device.claim_interface(interface_number).wait() {
                    Ok(i) => {
                        log("Claim succeeded once the daemon let go");
                        i
                    }
                    Err(e2) => {
                        log(&format!("Claim still refused: {e2}"));
                        return Err(format!(
                            "{msg}. macOS's PTP daemon still holds the camera after a killall retry; run `killall -9 ptpcamerad` and press Connect again."
                        ));
                    }
                }
            }
        };

        let descriptor = interface
            .descriptor()
            .ok_or_else(|| "the claimed interface has no active descriptor".to_string())?;
        let mut bulk_in = None;
        let mut bulk_out = None;
        let mut event_in = None;
        for ep in descriptor.endpoints() {
            match (ep.transfer_type(), ep.direction()) {
                (TransferType::Bulk, Direction::In) => bulk_in = Some(ep.address()),
                (TransferType::Bulk, Direction::Out) => bulk_out = Some(ep.address()),
                (TransferType::Interrupt, Direction::In) => event_in = Some(ep.address()),
                _ => {}
            }
        }
        let (Some(in_addr), Some(out_addr)) = (bulk_in, bulk_out) else {
            return Err(format!(
                "{label} does not offer the bulk pair PTP needs (in {bulk_in:?}, out {bulk_out:?})"
            ));
        };
        log(&format!(
            "Endpoints: bulk in 0x{in_addr:02x}, bulk out 0x{out_addr:02x}, event {:?}",
            event_in.map(|a| format!("0x{a:02x}"))
        ));
        let bulk_in_ep = interface
            .endpoint::<nusb::transfer::Bulk, nusb::transfer::In>(in_addr)
            .map_err(|e| format!("cannot open the bulk-in endpoint: {e}"))?;
        let bulk_out_ep = interface
            .endpoint::<nusb::transfer::Bulk, nusb::transfer::Out>(out_addr)
            .map_err(|e| format!("cannot open the bulk-out endpoint: {e}"))?;
        let event_ep = event_in.and_then(|a| {
            interface
                .endpoint::<nusb::transfer::Interrupt, nusb::transfer::In>(a)
                .ok()
        });
        let in_packet = bulk_in_ep.max_packet_size();
        let out_packet = bulk_out_ep.max_packet_size();

        let mut conn = CameraConnection {
            _device: device,
            _interface: interface,
            bulk_in: bulk_in_ep,
            bulk_out: bulk_out_ep,
            event_in: event_ep,
            in_packet,
            out_packet,
            transaction: 0,
            info: DeviceInfo::default(),
            known_handles: Vec::new(),
        };
        conn.transaction = 1;
        log("OpenSession");
        match conn.command(op::OPEN_SESSION, &[1], None) {
            Ok(_) => {}
            Err(e) if e.contains("session already open") => {
                // A crashed run can leave the body holding a session:
                // close it and take the seat rather than failing.
                log("A session was already open; closing it and retrying");
                let _ = conn.command(op::CLOSE_SESSION, &[], None);
                conn.transaction = 1;
                conn.command(op::OPEN_SESSION, &[1], None)?;
            }
            Err(e) => return Err(e),
        }
        log("GetDeviceInfo");
        let payload = conn.command(op::GET_DEVICE_INFO, &[], Some(true))?;
        let info = parse_device_info(&payload)?;
        log(&format!(
            "Connected: {} {} (firmware {}), {} operations, {} device properties",
            info.manufacturer,
            info.model,
            info.device_version,
            info.operations.len(),
            info.properties.len()
        ));
        if !can_capture(&info) {
            log(&no_capture_note(&info));
        } else if info.vendor_extension_id == panasonic::VENDOR_EXTENSION
            && !info.operations.contains(&op::INITIATE_CAPTURE)
        {
            log(
                "NOTE: Panasonic tether body; remote capture runs over vendor operation 0x9404, which the body hides from its operation list.",
            );
        }
        conn.info = info;
        // Snapshot the card so the watch knows "new" from "already
        // there": only frames shot after this moment are arrivals.
        let payload = conn.command(op::GET_OBJECT_HANDLES, &[0xFFFF_FFFF, 0, 0], Some(true))?;
        conn.known_handles = parse_handles(&payload);
        log(&format!("Card holds {} objects already; watching for new ones", conn.known_handles.len()));
        Ok(conn)
    }

    /// One round trip: command container out, optional data container
    /// in, response container in. Returns the data payload when the
    /// operation has a data phase.
    fn command(
        &mut self,
        code: u16,
        params: &[u32],
        data_in: Option<bool>,
    ) -> Result<Vec<u8>, String> {
        let tid = self.transaction;
        self.transaction += 1;
        self.send(&encode_container(CONTAINER_COMMAND, code, tid, params, &[]))?;
        let payload = if data_in == Some(true) {
            let data = self.read_container(CMD_TIMEOUT)?;
            if data.kind != CONTAINER_DATA {
                return Err(format!(
                    "expected a data container for {}, got type {}",
                    operation_name(code),
                    data.kind
                ));
            }
            data.payload
        } else {
            Vec::new()
        };
        let response = self.read_container(CMD_TIMEOUT)?;
        if response.kind != CONTAINER_RESPONSE {
            return Err(format!(
                "expected a response for {}, got type {}",
                operation_name(code),
                response.kind
            ));
        }
        if response.code != rsp::OK {
            return Err(format!(
                "{}: {}",
                operation_name(code),
                response_meaning(response.code)
            ));
        }
        Ok(payload)
    }

    /// A round trip with a data-OUT phase: command container, data
    /// container, response. SetProperty is the user.
    fn command_data_out(&mut self, code: u16, params: &[u32], payload: &[u8]) -> Result<(), String> {
        let tid = self.transaction;
        self.transaction += 1;
        self.send(&encode_container(CONTAINER_COMMAND, code, tid, params, &[]))?;
        self.send(&encode_container(CONTAINER_DATA, code, tid, &[], payload))?;
        let response = self.read_container(CMD_TIMEOUT)?;
        if response.kind != CONTAINER_RESPONSE {
            return Err(format!(
                "expected a response for {}, got type {}",
                operation_name(code),
                response.kind
            ));
        }
        if response.code != rsp::OK {
            return Err(format!(
                "{}: {}",
                operation_name(code),
                response_meaning(response.code)
            ));
        }
        Ok(())
    }

    /// 0x9402: the body's current value for a vendor property, as
    /// (value size, value). Panasonic settings are 32-bit codes, not
    /// the standard 16-bit property set.
    pub fn get_property(&mut self, code: u32) -> Result<(u16, u32), String> {
        let data = self.command(panasonic::OP_GET_PROPERTY, &[code], Some(true))?;
        parse_property_value(&data)
    }

    /// 0x9108: the descriptor, current value plus the accepted list.
    /// A GetProperty runs first to learn the value width from the body,
    /// the way libgphoto2 does it, so the descriptor parse never
    /// guesses.
    pub fn list_property(&mut self, code: u32) -> Result<PropertyDesc, String> {
        let (value_size, _) = self.get_property(code)?;
        let data = self.command(panasonic::OP_LIST_PROPERTY, &[code, 0, 0], Some(true))?;
        parse_property_desc(&data, code, value_size)
    }

    /// 0x9403: set a vendor property. Writes go to the _Param codes;
    /// the payload layout mirrors the GetProperty answer (propcode
    /// u32, value size u32, value at offset 8). This changes a camera
    /// setting, never the card.
    pub fn set_property(&mut self, code: u32, value_size: u16, value: u32) -> Result<(), String> {
        let payload = encode_set_property_payload(code, value_size, value)?;
        self.command_data_out(panasonic::OP_SET_PROPERTY, &[code], &payload)
    }

    /// Drive the lens focus one step: a mode from the panasonic table
    /// (0 stops a running drive). Moves the lens, touches nothing else;
    /// the body must be in a mode where focus drive is meaningful (MF
    /// on the body or lens, or the body may refuse or ignore).
    pub fn focus_drive(&mut self, mode: u16) -> Result<(), String> {
        self.command_data_out(
            panasonic::OP_FOCUS_DRIVE,
            &[panasonic::FOCUS_CONTROL],
            &encode_focus_drive_payload(mode),
        )
    }

    /// One autofocus sweep (0x9405 with the AF one-shot code), verified
    /// on the DC-S5 (2026-08-26): accepted, the lens swept, and the
    /// body answered with event 0xC104. The verified context is the
    /// live view stream running and the body in AF; a body in MF
    /// answers general error.
    pub fn autofocus(&mut self) -> Result<(), String> {
        self.command(panasonic::OP_AF_AE, &[panasonic::af::AF_ONE_SHOT], None)?;
        Ok(())
    }

    /// The one standard property the DC-S5 reports: battery level, a
    /// single byte over the plain PTP op. None when the body does not
    /// answer; a missing battery line is not an error worth a toast.
    pub fn battery_level(&mut self) -> Option<u8> {
        let data = self
            .command(op::GET_DEVICE_PROP_VALUE, &[0x5001], Some(true))
            .ok()?;
        data.first().copied()
    }

    /// Phase 3: start the live view stream. The body needs about 100 ms
    /// before frames flow, so the wait is part of the start, not the
    /// caller's problem.
    pub fn start_liveview(&mut self) -> Result<(), String> {
        self.command(panasonic::OP_LIVEVIEW, &[panasonic::LIVEVIEW_START], None)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// Stop the stream; the body returns to normal shooting.
    pub fn stop_liveview(&mut self) -> Result<(), String> {
        self.command(panasonic::OP_LIVEVIEW, &[panasonic::LIVEVIEW_STOP], None)?;
        Ok(())
    }

    /// One live view frame as JPEG bytes. Ok(None) is the body answering
    /// DeviceBusy: mid-work, ask again after a beat. The busy answer is
    /// matched on response_meaning's words because command() reports
    /// response codes as text; the words are pinned by the test below.
    pub fn liveview_frame(&mut self) -> Result<Option<Vec<u8>>, String> {
        match self.command(panasonic::OP_LIVEVIEW_IMAGE, &[], Some(true)) {
            Ok(data) => cut_liveview_jpeg(&data)
                .map(|jpeg| Some(jpeg.to_vec()))
                .ok_or_else(|| "the live view frame carried no JPEG".to_string()),
            Err(e) if e.ends_with(&response_meaning(rsp::DEVICE_BUSY)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        let completion = self
            .bulk_out
            .transfer_blocking(bytes.to_vec().into(), CMD_TIMEOUT);
        completion
            .status
            .map_err(|e| transfer_note(&e))?;
        // A write that lands exactly on the packet size needs a
        // zero-length packet to mark its end, per the USB spec.
        if bytes.len() % self.out_packet.max(1) == 0 {
            let zlp = self
                .bulk_out
                .transfer_blocking(Vec::<u8>::new().into(), CMD_TIMEOUT);
            zlp.status.map_err(|e| transfer_note(&e))?;
        }
        Ok(())
    }

    /// Read one container however many packets it spans: the first four
    /// bytes say the total, and the loop reads until it has them all.
    fn read_container(&mut self, timeout: Duration) -> Result<Container, String> {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let want = {
                let total = if buf.len() >= 4 {
                    u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize
                } else {
                    64 * 1024
                };
                let remaining = total.saturating_sub(buf.len()).max(self.in_packet);
                let chunk = remaining.min(1024 * 1024);
                // nusb needs the request a nonzero multiple of the
                // packet size.
                chunk.div_ceil(self.in_packet) * self.in_packet
            };
            let completion = self
                .bulk_in
                .transfer_blocking(Buffer::new(want), timeout);
            completion.status.map_err(|e| transfer_note(&e))?;
            let got = &completion.buffer[..];
            if got.is_empty() && !buf.is_empty() {
                break;
            }
            buf.extend_from_slice(got);
            if buf.len() >= 4 {
                let total = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
                if buf.len() >= total {
                    break;
                }
            }
        }
        decode_container(&buf)
    }

    /// Fire the shutter and fetch the frame. Returns the file bytes and
    /// the name the camera gave them. The body writes to its own card;
    /// nothing on the card is touched beyond reading the new object.
    pub fn capture<F: Fn(&str)>(&mut self, log: &F) -> Result<(String, Vec<u8>), String> {
        if !self.info.operations.contains(&op::INITIATE_CAPTURE) {
            if self.info.vendor_extension_id == panasonic::VENDOR_EXTENSION {
                return self.capture_panasonic(log);
            }
            return Err(
                "this body does not offer remote capture in its current USB mode; on Lumix, pick the PC tether / PC Remote mode on the camera"
                    .to_string(),
            );
        }
        // The handles on show before the shot, so an ObjectAdded event
        // that never comes still leaves a way to find the new frame.
        log("Reading object handles before capture");
        let before_payload = self.command(op::GET_OBJECT_HANDLES, &[0xFFFF_FFFF, 0, 0], Some(true))?;
        let before = parse_handles(&before_payload);

        log("InitiateCapture");
        self.command(op::INITIATE_CAPTURE, &[0, 0], None)?;

        let handle = self
            .wait_for_new_object(&before, log)
            .ok_or_else(|| "the shutter fired but no new object appeared; check the card has room".to_string())?;
        log(&format!("New object handle {handle:#x}"));
        self.known_handles.push(handle);
        let frame = self.fetch_object(handle, log);
        if frame.is_err() {
            self.unwedge(log);
        }
        frame
    }

    /// Panasonic tether capture, the sequence LUMIX Tether runs (per
    /// libgphoto2): drain stale events, vendor release 0x9404 with
    /// parameter 0x03000011, then wait on the interrupt pipe for the
    /// vendor ObjectAdded (card or SDRAM). Mid-capture event 0xC101
    /// expects a 0x9401 reply; without it some bodies stall before
    /// announcing the frame. Event 0xC107 is the body saying it is
    /// still working.
    fn capture_panasonic<F: Fn(&str)>(&mut self, log: &F) -> Result<(String, Vec<u8>), String> {
        log("Reading object handles before capture");
        let before_payload = self.command(op::GET_OBJECT_HANDLES, &[0xFFFF_FFFF, 0, 0], Some(true))?;
        let before = parse_handles(&before_payload);
        self.drain_events(log);

        log("Panasonic InitiateCapture (0x9404)");
        self.command(panasonic::OP_INITIATE_CAPTURE, &[panasonic::CAPTURE_PARAM], None)?;

        let deadline = std::time::Instant::now() + CAPTURE_TIMEOUT;
        let mut handle = None;
        while handle.is_none() && std::time::Instant::now() < deadline {
            if let Some((code, param)) = self.read_event(Duration::from_millis(1500), log) {
                match code {
                    panasonic::EV_OBJECT_ADDED | panasonic::EV_OBJECT_ADDED_SDRAM => {
                        // The body announces a new DCIM folder the same
                        // way (seen live on the DC-S5); the frame's own
                        // announcement follows.
                        if self.is_folder(param) {
                            log(&format!(
                                "Handle {param:#x} is a folder; waiting for the frame itself"
                            ));
                        } else {
                            handle = Some(param);
                        }
                    }
                    panasonic::EV_QUERY => {
                        let _ = self.command(panasonic::OP_EVENT_ACK, &[param], Some(true));
                    }
                    panasonic::EV_BUSY => {}
                    other => log(&format!("Event 0x{other:04X} (unhandled)")),
                }
                continue;
            }
            // No event in this window: diff the handle list, folders
            // excluded for the same reason.
            if let Ok(payload) = self.command(op::GET_OBJECT_HANDLES, &[0xFFFF_FFFF, 0, 0], Some(true)) {
                let after = parse_handles(&payload);
                if let Some(h) = after
                    .iter()
                    .find(|h| !before.contains(h) && !self.is_folder(**h))
                {
                    handle = Some(*h);
                }
            }
        }
        let handle = handle.ok_or_else(|| {
            "the shutter fired but the body announced no new frame; check the card has room"
                .to_string()
        })?;
        log(&format!("New object handle {handle:#x}"));
        // A frame read the instant it is announced can answer mid-write.
        std::thread::sleep(Duration::from_millis(50));
        self.known_handles.push(handle);
        let frame = self.fetch_object(handle, log);
        if frame.is_err() {
            self.unwedge(log);
        }
        frame
    }

    /// Fetch one object off the card: its name from the info dataset,
    /// then its bytes. Read-only; the card is never written or deleted.
    /// A folder (association) object is refused before the GetObject:
    /// reading one stalls the pipe and wedges the session (seen live on
    /// the DC-S5, which announces its new DCIM folder over ObjectAdded
    /// ahead of the frame itself).
    fn fetch_object<F: Fn(&str)>(&mut self, handle: u32, log: &F) -> Result<(String, Vec<u8>), String> {
        let info = self.command(op::GET_OBJECT_INFO, &[handle], Some(true)).ok();
        if info
            .as_deref()
            .and_then(parse_object_info_format)
            == Some(FORMAT_ASSOCIATION)
        {
            return Err(format!("handle {handle:#x} is a folder, not a frame"));
        }
        let name = info
            .and_then(|payload| parse_object_info_filename(&payload).ok())
            .unwrap_or_else(|| format!("capture-{handle:#x}.rw2"));

        log(&format!("Fetching {name}"));
        let tid = self.transaction;
        self.transaction += 1;
        self.send(&encode_container(CONTAINER_COMMAND, op::GET_OBJECT, tid, &[handle], &[]))?;
        let data = self.read_container(CAPTURE_TIMEOUT)?;
        if data.kind != CONTAINER_DATA {
            return Err("GetObject: the camera answered without data".to_string());
        }
        let response = self.read_container(CMD_TIMEOUT)?;
        if response.code != rsp::OK {
            return Err(format!("GetObject: {}", response_meaning(response.code)));
        }
        Ok((name, data.payload))
    }

    /// True when the handle is a folder the camera announced alongside
    /// the frame. Unknown (info unreadable) counts as not a folder:
    /// the fetch then answers for itself.
    fn is_folder(&mut self, handle: u32) -> bool {
        self.command(op::GET_OBJECT_INFO, &[handle], Some(true))
            .ok()
            .as_deref()
            .and_then(parse_object_info_format)
            == Some(FORMAT_ASSOCIATION)
    }

    /// A stalled bulk pipe wedges the whole session: every later
    /// command times out, even CloseSession. Clearing the halt
    /// condition on both bulk endpoints is the standard recovery and
    /// lets the card watch keep running after a failed fetch.
    fn unwedge<F: Fn(&str)>(&mut self, log: &F) {
        log("Clearing stalled pipes");
        if let Err(e) = self.bulk_in.clear_halt().wait() {
            log(&format!("clear_halt bulk in: {e}"));
        }
        if let Err(e) = self.bulk_out.clear_halt().wait() {
            log(&format!("clear_halt bulk out: {e}"));
        }
    }

    /// The card watch: diff the handle list against the connect-time
    /// snapshot and fetch whatever is new. This is how a shot fired on
    /// the camera itself lands in Heeler when the body announces no
    /// ObjectAdded event (the DC-S5 in plain PTP mode is one). A frame
    /// that fails to fetch stays unknown, so the next poll retries it:
    /// a RAW the camera is mid-writing is exactly the case that must
    /// not import half-finished.
    pub fn poll_new<F: Fn(&str)>(&mut self, log: &F) -> Result<Vec<(String, Vec<u8>)>, String> {
        let payload = self.command(op::GET_OBJECT_HANDLES, &[0xFFFF_FFFF, 0, 0], Some(true))?;
        let now = parse_handles(&payload);
        let fresh: Vec<u32> = now
            .iter()
            .copied()
            .filter(|h| !self.known_handles.contains(h))
            .collect();
        let mut out = Vec::new();
        for handle in fresh {
            // A folder announces itself like a frame; it is known from
            // now on, but fetching one stalls the pipe, so it is never
            // fetched.
            if self.is_folder(handle) {
                log(&format!("Handle {handle:#x} is a folder; skipping it"));
                self.known_handles.push(handle);
                continue;
            }
            match self.fetch_object(handle, log) {
                Ok(frame) => {
                    self.known_handles.push(handle);
                    out.push(frame);
                }
                Err(e) => {
                    log(&format!("Handle {handle:#x} not ready ({e}); next poll retries it"));
                    self.unwedge(log);
                }
            }
        }
        Ok(out)
    }

    /// The interrupt pipe carries ObjectAdded; a body without one (or
    /// macOS declining to deliver) falls back to diffing the handle
    /// list after a wait. Folders announce over ObjectAdded too and
    /// never count as the frame.
    fn wait_for_new_object<F: Fn(&str)>(&mut self, before: &[u32], log: &F) -> Option<u32> {
        let deadline = std::time::Instant::now() + CAPTURE_TIMEOUT;
        while std::time::Instant::now() < deadline {
            if let Some((code, param)) = self.read_event(Duration::from_millis(1500), log) {
                if code == event::OBJECT_ADDED {
                    if self.is_folder(param) {
                        log(&format!(
                            "Handle {param:#x} is a folder; waiting for the frame itself"
                        ));
                    } else {
                        return Some(param);
                    }
                }
                continue;
            }
            // No event in this window: diff the handle list.
            if let Ok(payload) = self.command(op::GET_OBJECT_HANDLES, &[0xFFFF_FFFF, 0, 0], Some(true)) {
                let after = parse_handles(&payload);
                if let Some(h) = after
                    .iter()
                    .find(|h| !before.contains(h) && !self.is_folder(**h))
                {
                    return Some(*h);
                }
            }
        }
        None
    }

    /// One interrupt-pipe read as (code, first parameter); None on
    /// timeout, on a body with no event endpoint, or on a packet that
    /// is not an event container.
    fn read_event<F: Fn(&str)>(&mut self, window: Duration, log: &F) -> Option<(u16, u32)> {
        let ep = self.event_in.as_mut()?;
        let completion =
            ep.transfer_blocking(Buffer::new(64 * self.in_packet.max(64)), window);
        if !completion.status.is_ok() {
            return None;
        }
        let ev = decode_container(&completion.buffer[..]).ok()?;
        if ev.kind != CONTAINER_EVENT {
            return None;
        }
        log(&format!("Event {}", event_name(ev.code)));
        Some((ev.code, ev.params.first().copied().unwrap_or(0)))
    }

    /// Read whatever is sitting on the interrupt pipe, so the next
    /// event waited on belongs to the next shot and not to an earlier
    /// one. LUMIX Tether traces drain the pipe the same way before
    /// capture.
    fn drain_events<F: Fn(&str)>(&mut self, log: &F) {
        while let Some((code, _)) = self.read_event(Duration::from_millis(200), log) {
            log(&format!("Drained stale event 0x{code:04X}"));
        }
    }

    /// Close the PTP session. The interface releases when the
    /// connection drops.
    pub fn close<F: Fn(&str)>(&mut self, log: &F) {
        log("CloseSession");
        if let Err(e) = self.command(op::CLOSE_SESSION, &[], None) {
            log(&format!("CloseSession: {e}"));
        }
    }
}

/// A GetObjectHandles payload: u32 count, then that many u32 handles.
pub fn parse_handles(bytes: &[u8]) -> Vec<u32> {
    let Ok(count) = rd_u32(bytes, 0) else {
        return Vec::new();
    };
    (0..count as usize)
        .filter_map(|i| rd_u32(bytes, 4 + i * 4).ok())
        .collect()
}

/// The JPEG inside a 0x9706 live view payload: from the SOI marker
/// 0xFFD8 to the EOI marker 0xFFD9 that follows it, inclusive. The
/// header before it (about 128 bytes per the spec) and anything after
/// are the body's framing, not the picture. None when the payload holds
/// no JPEG at all.
pub fn cut_liveview_jpeg(payload: &[u8]) -> Option<&[u8]> {
    let start = payload.windows(2).position(|w| w == [0xFF, 0xD8])?;
    let eoi = payload[start + 2..]
        .windows(2)
        .position(|w| w == [0xFF, 0xD9])?;
    Some(&payload[start..start + 2 + eoi + 2])
}

/// The connected body's report section: identity, operations, and the
/// property set, named where the standard names them. This text is what
/// phase 2 (exposure control) gets built against.
pub fn device_report(info: &DeviceInfo) -> Vec<String> {
    let family = device_family(info);
    let mut lines = vec![
        format!(
            "Device: {} {} firmware {} serial {}",
            info.manufacturer, info.model, info.device_version, info.serial
        ),
        format!(
            "PTP {} / vendor extension {:#x}{} {}",
            info.standard_version,
            info.vendor_extension_id,
            family.name().map(|n| format!(" ({n})")).unwrap_or_default(),
            info.vendor_extension_desc
        ),
        format!(
            "Operations ({}): {}",
            info.operations.len(),
            info.operations
                .iter()
                .map(|c| operation_name_for(family, *c))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!(
            "Events ({}): {}",
            info.events.len(),
            info.events
                .iter()
                .map(|c| event_name(*c))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!(
            "Device properties ({}): {}",
            info.properties.len(),
            info.properties
                .iter()
                .map(|c| property_name(*c))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!(
            "Capture formats ({}): {}",
            info.capture_formats.len(),
            info.capture_formats
                .iter()
                .map(|c| format!("0x{c:04X}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!(
            "Image formats ({}): {}",
            info.image_formats.len(),
            info.image_formats
                .iter()
                .map(|c| format!("0x{c:04X}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ];
    lines.retain(|l| !l.is_empty());
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A canned GetDeviceInfo dataset for a fictional Lumix-ish body,
    /// built field by field so the fixture documents the layout.
    fn device_info_fixture() -> Vec<u8> {
        let mut b = Vec::new();
        let push_str = |b: &mut Vec<u8>, s: &str| {
            let units: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
            b.push(units.len() as u8);
            for u in units {
                b.extend_from_slice(&u.to_le_bytes());
            }
        };
        let push_arr = |b: &mut Vec<u8>, values: &[u16]| {
            b.extend_from_slice(&(values.len() as u32).to_le_bytes());
            for v in values {
                b.extend_from_slice(&v.to_le_bytes());
            }
        };
        b.extend_from_slice(&100u16.to_le_bytes()); // standard version 1.00
        b.extend_from_slice(&6u32.to_le_bytes()); // vendor extension id
        b.extend_from_slice(&100u16.to_le_bytes()); // vendor extension version
        push_str(&mut b, "panasonic.com"); // vendor extension desc
        b.extend_from_slice(&0u16.to_le_bytes()); // functional mode
        push_arr(&mut b, &[op::GET_DEVICE_INFO, op::OPEN_SESSION, op::CLOSE_SESSION, op::GET_OBJECT_HANDLES, op::GET_OBJECT_INFO, op::GET_OBJECT, op::INITIATE_CAPTURE]);
        push_arr(&mut b, &[event::OBJECT_ADDED, event::CAPTURE_COMPLETE]);
        push_arr(&mut b, &[0x5001, 0x500D, 0x5007, 0x500F, 0xD801]);
        push_arr(&mut b, &[0x3801]);
        push_arr(&mut b, &[0x3000, 0x3801, 0xB101]);
        push_str(&mut b, "Panasonic");
        push_str(&mut b, "DC-G9M3");
        push_str(&mut b, "1.0");
        push_str(&mut b, "ABC123");
        b
    }

    #[test]
    fn container_round_trip() {
        let bytes = encode_container(CONTAINER_COMMAND, op::INITIATE_CAPTURE, 7, &[0, 0], &[]);
        assert_eq!(bytes.len(), 20);
        let c = decode_container(&bytes).unwrap();
        assert_eq!((c.kind, c.code, c.transaction), (CONTAINER_COMMAND, op::INITIATE_CAPTURE, 7));
        assert_eq!(c.params, Vec::<u32>::new());
        // Command containers keep their parameters in the payload half;
        // the sender encodes them, the camera decodes them.
        assert_eq!(c.payload, vec![0, 0, 0, 0, 0, 0, 0, 0]);

        let response = encode_container(CONTAINER_RESPONSE, rsp::OK, 7, &[], &[]);
        let c = decode_container(&response).unwrap();
        assert_eq!(c.code, rsp::OK);

        let event = encode_container(CONTAINER_EVENT, event::OBJECT_ADDED, 0, &[0x1234], &[]);
        let c = decode_container(&event).unwrap();
        assert_eq!(c.params, vec![0x1234]);
    }

    #[test]
    fn decode_refuses_garbage() {
        assert!(decode_container(&[1, 2, 3]).is_err());
        let mut lies = encode_container(CONTAINER_RESPONSE, rsp::OK, 1, &[], &[]);
        lies[0] = 200; // declares more than arrived
        assert!(decode_container(&lies).is_err());
    }

    #[test]
    fn device_info_parses() {
        let info = parse_device_info(&device_info_fixture()).unwrap();
        assert_eq!(info.standard_version, 100);
        assert_eq!(info.vendor_extension_id, 6);
        assert_eq!(info.vendor_extension_desc, "panasonic.com");
        assert_eq!(info.manufacturer, "Panasonic");
        assert_eq!(info.model, "DC-G9M3");
        assert_eq!(info.device_version, "1.0");
        assert_eq!(info.serial, "ABC123");
        assert!(info.operations.contains(&op::INITIATE_CAPTURE));
        assert_eq!(info.properties.len(), 5);
        assert_eq!(info.image_formats, vec![0x3000, 0x3801, 0xB101]);
        // The report names what the standard names and hexes the rest:
        // 0xD801 is a vendor property and must stay hex.
        let report = device_report(&info).join("\n");
        assert!(report.contains("DC-G9M3"));
        assert!(report.contains("InitiateCapture"));
        assert!(report.contains("ExposureTime"));
        assert!(report.contains("0xD801"));
    }

    #[test]
    fn capture_capability_covers_panasonic_tether_bodies() {
        let mut info = parse_device_info(&device_info_fixture()).unwrap();
        assert!(can_capture(&info));
        // The DC-S5 in PC(Tether) mode reports vendor extension 0x1C
        // and hides InitiateCapture from its operation list; the vendor
        // release operation is real anyway.
        info.operations.retain(|&o| o != op::INITIATE_CAPTURE);
        assert!(!can_capture(&info));
        info.vendor_extension_id = panasonic::VENDOR_EXTENSION;
        assert!(can_capture(&info));
        assert!(operation_name(panasonic::OP_INITIATE_CAPTURE).contains("Panasonic"));
    }

    #[test]
    fn device_info_truncation_is_an_error_not_a_panic() {
        let fixture = device_info_fixture();
        for cut in [0, 3, 9, fixture.len() / 2, fixture.len() - 2] {
            assert!(parse_device_info(&fixture[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn object_info_filename_parses() {
        let mut b = vec![0u8; 52];
        let units: Vec<u16> = "P1000123.RW2".encode_utf16().chain(std::iter::once(0)).collect();
        b.push(units.len() as u8);
        for u in units {
            b.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(parse_object_info_filename(&b).unwrap(), "P1000123.RW2");
        assert!(parse_object_info_filename(&vec![0u8; 52]).is_err());
    }

    #[test]
    fn object_info_format_tells_a_folder_from_a_frame() {
        let mut folder = vec![0u8; 52];
        folder[4..6].copy_from_slice(&0x3001u16.to_le_bytes());
        assert_eq!(parse_object_info_format(&folder), Some(FORMAT_ASSOCIATION));
        let mut frame = vec![0u8; 52];
        frame[4..6].copy_from_slice(&0xB003u16.to_le_bytes());
        assert_eq!(parse_object_info_format(&frame), Some(0xB003));
        assert_eq!(parse_object_info_format(&[0u8; 3]), None);
    }

    #[test]
    fn handles_parse() {
        let mut b = Vec::new();
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&0xAAAAu32.to_le_bytes());
        b.extend_from_slice(&0xBBBBu32.to_le_bytes());
        assert_eq!(parse_handles(&b), vec![0xAAAA, 0xBBBB]);
        assert!(parse_handles(&[1]).is_empty());
    }

    #[test]
    fn property_value_parses_both_widths() {
        // u32 header, u32 value size, then the value: ISO 400.
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&4u32.to_le_bytes());
        b.extend_from_slice(&400u32.to_le_bytes());
        assert_eq!(parse_property_value(&b).unwrap(), (4, 400));
        // A 2-byte value, white balance auto.
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        assert_eq!(parse_property_value(&b).unwrap(), (2, 2));
        assert!(parse_property_value(&[0u8; 4]).is_err());
        // A width we cannot read is an error, not a guess.
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&[0u8; 4]);
        assert!(parse_property_value(&b).is_err());
    }

    #[test]
    fn set_property_payload_puts_the_value_at_offset_eight() {
        // The layout mirrors the GetProperty answer: code u32, size
        // u32, value. A 4-byte ISO 800:
        let p = encode_set_property_payload(panasonic::prop::ISO_PARAM, 4, 800).unwrap();
        assert_eq!(p.len(), 12);
        assert_eq!(u32::from_le_bytes(p[0..4].try_into().unwrap()), panasonic::prop::ISO_PARAM);
        assert_eq!(u32::from_le_bytes(p[4..8].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(p[8..12].try_into().unwrap()), 800);
        // A 2-byte white balance value, same fixed offset.
        let p = encode_set_property_payload(panasonic::prop::WHITE_BALANCE_PARAM, 2, 4).unwrap();
        assert_eq!(p.len(), 10);
        assert_eq!(u32::from_le_bytes(p[4..8].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(p[8..10].try_into().unwrap()), 4);
        assert!(encode_set_property_payload(panasonic::prop::ISO_PARAM, 3, 0).is_err());
    }

    #[test]
    fn property_descriptor_parses_current_and_allowed() {
        // Layout per libgphoto2: block count, header length in u32s,
        // property code at offset 28; current value at header*4 + 8,
        // then the count, then the values. Header length 7 puts the
        // value at offset 36.
        let mut b = Vec::new();
        b.extend_from_slice(&1u32.to_le_bytes()); // block count
        b.extend_from_slice(&7u32.to_le_bytes()); // header length
        b.extend_from_slice(&[0u8; 20]); // header body
        b.extend_from_slice(&panasonic::prop::ISO.to_le_bytes()); // code at 28
        b.extend_from_slice(&[0u8; 4]); // pad to 36
        b.extend_from_slice(&200u32.to_le_bytes()); // current: ISO 200
        b.extend_from_slice(&3u32.to_le_bytes()); // three allowed values
        for v in [100u32, 200, 400] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        let desc = parse_property_desc(&b, panasonic::prop::ISO, 4).unwrap();
        assert_eq!(desc.code, panasonic::prop::ISO);
        assert_eq!(desc.value_size, 4);
        assert_eq!(desc.current, 200);
        assert_eq!(desc.allowed, vec![100, 200, 400]);
        // Truncations are errors, not partial reads.
        assert!(parse_property_desc(&b[..20], panasonic::prop::ISO, 4).is_err());
        assert!(parse_property_desc(&b[..44], panasonic::prop::ISO, 4).is_err());
        assert!(parse_property_desc(&b[..b.len() - 2], panasonic::prop::ISO, 4).is_err());
        assert!(parse_property_desc(&b, panasonic::prop::ISO, 3).is_err());
    }

    #[test]
    fn classification_names_the_mode_problem() {
        // A Lumix presenting its PTP interface.
        assert_eq!(classify(0x04DA, &[6, 8]), CameraVerdict::PtpCapable);
        // The same body in card-reader mode: the remedy is on the body.
        let v = classify(0x04DA, &[8]);
        assert_eq!(v, CameraVerdict::MassStorageOnly);
        assert!(v.note().contains("USB mode"));
        // A known maker with nothing imaging-shaped on show.
        assert_eq!(classify(0x04A9, &[3]), CameraVerdict::KnownCameraNoImaging);
        // An unknown vendor with a PTP interface is still a candidate.
        assert_eq!(classify(0x1234, &[6]), CameraVerdict::PtpCapable);
        // A keyboard is not a camera.
        assert_eq!(classify(0x05AC, &[3]), CameraVerdict::NotCamera);
    }

    #[test]
    fn the_report_says_what_was_seen_even_when_nothing_matches() {
        let report = diagnostic_report(&[], 11, &[]);
        assert!(report.contains("11 USB devices on the bus; 0 camera-shaped"));
        assert!(report.contains("No camera-shaped device seen"));

        let probes = vec![CameraProbe {
            key: "04da:2372:0:4".into(),
            vendor_id: 0x04DA,
            product_id: 0x2372,
            name: "DC-G9M3".into(),
            manufacturer: Some("Panasonic".into()),
            serial: Some("ABC123".into()),
            verdict: CameraVerdict::MassStorageOnly,
            note: CameraVerdict::MassStorageOnly.note().into(),
            interfaces: vec![8, 6],
        }];
        let report = diagnostic_report(&probes, 12, &["extra line".into()]);
        assert!(report.contains("04da:2372 DC-G9M3 serial ABC123"));
        assert!(report.contains("card-reader mode"));
        assert!(report.contains("interfaces: 8 (mass storage / card), 6 (still image / PTP)"));
        assert!(report.contains("extra line"));
    }

    /// Heeler ships no driver package on Windows by choice, so the Zadig
    /// remedy and its page are the entire Windows story. Losing either
    /// string leaves a Windows user with a camera the scan can see, a
    /// CONNECT that refuses, and no way forward, so both are pinned.
    #[cfg(target_os = "windows")]
    #[test]
    fn the_windows_report_carries_the_driver_remedy_and_its_page() {
        let report = diagnostic_report(&[], 3, &[]);
        assert!(report.contains("Zadig"));
        assert!(report.contains("Connecting a camera over USB"));
    }

    #[test]
    fn family_tables_agree_across_usb_ids_and_extension_ids() {
        assert_eq!(Family::from_vendor_id(0x04A9), Family::Canon);
        assert_eq!(Family::from_vendor_id(0x04B0), Family::Nikon);
        assert_eq!(Family::from_vendor_id(0x04CB), Family::Fujifilm);
        assert_eq!(Family::from_vendor_id(0x04DA), Family::Panasonic);
        assert_eq!(Family::from_vendor_id(0x054C), Family::Sony);
        assert_eq!(Family::from_vendor_id(0x1234), Family::Unknown);
        assert_eq!(Family::from_extension_id(panasonic::VENDOR_EXTENSION), Family::Panasonic);
        assert_eq!(Family::from_extension_id(canon::VENDOR_EXTENSION), Family::Canon);
        assert_eq!(Family::from_extension_id(nikon::VENDOR_EXTENSION), Family::Nikon);
        assert_eq!(Family::from_extension_id(fuji::VENDOR_EXTENSION), Family::Fujifilm);
        assert_eq!(Family::from_extension_id(sony::VENDOR_EXTENSION), Family::Sony);
        assert_eq!(Family::from_extension_id(0), Family::Unknown);
        // camera_vendor_name is the display spelling of the same table.
        assert_eq!(camera_vendor_name(0x04A9), Family::Canon.name());
        assert_eq!(camera_vendor_name(0x1234), None);
        // No two families share an extension id; a collision would
        // misname a connected body's whole operation table.
        let mut exts = vec![
            panasonic::VENDOR_EXTENSION,
            canon::VENDOR_EXTENSION,
            nikon::VENDOR_EXTENSION,
            fuji::VENDOR_EXTENSION,
            sony::VENDOR_EXTENSION,
        ];
        let count = exts.len();
        exts.sort();
        exts.dedup();
        assert_eq!(exts.len(), count);
    }

    #[test]
    fn the_scan_report_states_family_readiness_honestly() {
        assert!(Family::Panasonic.readiness().contains("verified"));
        assert!(Family::Canon.readiness().contains("unwired"));
        assert!(Family::Sony.readiness().contains("unwired"));
        let probes = vec![CameraProbe {
            key: "04a9:3294:0:7".into(),
            vendor_id: 0x04A9,
            product_id: 0x3294,
            name: "EOS R5".into(),
            manufacturer: Some("Canon Inc.".into()),
            serial: None,
            verdict: CameraVerdict::PtpCapable,
            note: CameraVerdict::PtpCapable.note().into(),
            interfaces: vec![6],
        }];
        let report = diagnostic_report(&probes, 9, &[]);
        assert!(report.contains("family: Canon"));
        assert!(report.contains("unwired"));
    }

    #[test]
    fn the_no_capture_note_names_the_family_and_its_remedy() {
        let mut info = parse_device_info(&device_info_fixture()).unwrap();
        info.operations.retain(|&o| o != op::INITIATE_CAPTURE);
        // A Lumix in tether extension gets the PC tether remedy.
        info.vendor_extension_id = panasonic::VENDOR_EXTENSION;
        assert!(no_capture_note(&info).contains("PC tether"));
        // A Canon EOS gets honesty about the tabled vendor sequence.
        info.vendor_extension_id = canon::VENDOR_EXTENSION;
        let note = no_capture_note(&info);
        assert!(note.contains("EOS"));
        assert!(note.contains("unwired"));
        // A Lumix reporting a plain extension still gets the Lumix
        // remedy, keyed off the manufacturer string.
        info.vendor_extension_id = 6;
        assert!(no_capture_note(&info).contains("PC tether"));
        // An unknown maker gets the generic check-the-mode advice.
        info.manufacturer = "Unknown Maker".to_string();
        assert!(no_capture_note(&info).contains("USB mode"));
    }

    #[test]
    fn operation_names_follow_the_connected_family() {
        // The vendor code space overlaps: 0x9102 reads Panasonic on a
        // Lumix and EOS GetStorageInfo is a Canon code elsewhere. The
        // family picks the table.
        assert_eq!(
            operation_name_for(Family::Canon, canon::OP_SET_REMOTE_MODE),
            "Canon EOS SetRemoteMode"
        );
        assert_eq!(
            operation_name_for(Family::Nikon, nikon::OP_MF_DRIVE),
            "Nikon MfDrive"
        );
        assert_eq!(
            operation_name_for(Family::Sony, sony::OP_SDIO_CONNECT),
            "Sony SDIO Connect"
        );
        // Codes outside the family's table fall back to shared naming,
        // and unknown codes stay hex.
        assert_eq!(
            operation_name_for(Family::Canon, op::GET_DEVICE_INFO),
            "GetDeviceInfo"
        );
        assert_eq!(operation_name_for(Family::Canon, 0x9FFF), "0x9FFF");
        // The device report names the family on the extension line.
        let mut info = parse_device_info(&device_info_fixture()).unwrap();
        info.vendor_extension_id = panasonic::VENDOR_EXTENSION;
        let report = device_report(&info).join("\n");
        assert!(report.contains("vendor extension 0x1c (Panasonic)"));
    }

    /// The hardware test: run with `cargo test -p heeler-desktop
    /// connect_to_a_real_camera -- --ignored --nocapture` and a body on
    /// USB in a PTP mode. It prints the full device report; it never
    /// fires the shutter on its own.
    #[test]
    #[ignore]
    fn connect_to_a_real_camera() {
        let (probes, total) = probe_cameras();
        eprintln!("{}", diagnostic_report(&probes, total, &[]));
        let Some(p) = probes.iter().find(|p| p.verdict == CameraVerdict::PtpCapable) else {
            panic!("no PTP-capable camera on the bus");
        };
        let log = |m: &str| eprintln!("[ptp] {m}");
        let mut conn = CameraConnection::connect(&p.key, &log).expect("connect");
        for line in device_report(&conn.info) {
            eprintln!("[ptp] {line}");
        }
        conn.close(&log);
    }

    /// Phase 2's first hardware run: dump the raw property descriptors
    /// for the exposure triangle and white balance. Run with
    /// `cargo test -p heeler-desktop --lib panasonic_property_descriptors -- --ignored --nocapture`
    /// and a Panasonic body connected in PC(Tether) mode. The raw hex
    /// is the evidence that settles the aperture encoding before any UI
    /// decode ships; it never sets a value and never fires the shutter.
    #[test]
    #[ignore]
    fn panasonic_property_descriptors() {
        let (probes, _) = probe_cameras();
        let Some(p) = probes.iter().find(|p| p.verdict == CameraVerdict::PtpCapable) else {
            panic!("no PTP-capable camera on the bus");
        };
        let log = |m: &str| eprintln!("[ptp] {m}");
        let mut conn = CameraConnection::connect(&p.key, &log).expect("connect");
        if conn.info.vendor_extension_id != panasonic::VENDOR_EXTENSION {
            panic!("the connected body is not a Panasonic tether body");
        }
        for (name, code) in [
            ("ISO", panasonic::prop::ISO),
            ("ShutterSpeed", panasonic::prop::SHUTTER_SPEED),
            ("Aperture", panasonic::prop::APERTURE),
            ("WhiteBalance", panasonic::prop::WHITE_BALANCE),
        ] {
            match conn.list_property(code) {
                Ok(desc) => {
                    eprintln!(
                        "[ptp] {name} ({code:#010x}): value size {} bytes, current {:#010x} ({}), {} allowed values:",
                        desc.value_size,
                        desc.current,
                        desc.current,
                        desc.allowed.len()
                    );
                    for v in &desc.allowed {
                        eprintln!("[ptp]   {v:#010x} ({v})");
                    }
                }
                Err(e) => eprintln!("[ptp] {name} ({code:#010x}): {e}"),
            }
        }
        conn.close(&log);
    }

    /// The live view frame cutter: the JPEG sits between SOI and EOI,
    /// the body's header and any tail stay behind.
    #[test]
    fn the_live_view_payload_gives_up_its_jpeg() {
        let mut payload = vec![0u8; 128];
        payload.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]);
        payload.extend_from_slice(&[9, 9, 9]);
        let jpeg = cut_liveview_jpeg(&payload).unwrap();
        assert_eq!(jpeg, &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]);
        // No SOI, no frame; an SOI with no EOI is a truncated frame,
        // not a picture.
        assert!(cut_liveview_jpeg(&[1, 2, 3]).is_none());
        assert!(cut_liveview_jpeg(&[0xFF, 0xD8, 1, 2]).is_none());
        // The busy answer the frame pump retries on is matched on these
        // words; if the wording changes, liveview_frame must change too.
        assert_eq!(response_meaning(rsp::DEVICE_BUSY), "camera busy");
    }

    /// Phase 3's first hardware run: start live view, pull 30 frames, check each for
    /// SOI/EOI, print frame sizes and the achieved rate. Run with `cargo test -p
    /// heeler-desktop --lib panasonic_live_view_frames -- --ignored --nocapture` and a
    /// Panasonic body connected in PC(Tether) mode. It never fires the shutter and always
    /// stops the stream before letting go.
    #[test]
    #[ignore]
    fn panasonic_live_view_frames() {
        let (probes, _) = probe_cameras();
        let Some(p) = probes.iter().find(|p| p.verdict == CameraVerdict::PtpCapable) else {
            panic!("no PTP-capable camera on the bus");
        };
        let log = |m: &str| eprintln!("[ptp] {m}");
        let mut conn = CameraConnection::connect(&p.key, &log).expect("connect");
        if conn.info.vendor_extension_id != panasonic::VENDOR_EXTENSION {
            panic!("the connected body is not a Panasonic tether body");
        }
        conn.start_liveview().expect("start live view");
        let started = std::time::Instant::now();
        let mut sizes: Vec<usize> = Vec::new();
        while sizes.len() < 30 {
            match conn.liveview_frame() {
                Ok(Some(jpeg)) => sizes.push(jpeg.len()),
                // Mid-work: wait 40 ms and ask again, as libgphoto2 does.
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                Err(e) => {
                    let _ = conn.stop_liveview();
                    conn.close(&log);
                    panic!("frame {} failed: {e}", sizes.len() + 1);
                }
            }
            if started.elapsed() > Duration::from_secs(30) {
                let _ = conn.stop_liveview();
                conn.close(&log);
                panic!("30 frames did not arrive in 30 s (got {})", sizes.len());
            }
        }
        let elapsed = started.elapsed();
        conn.stop_liveview().expect("stop live view");
        conn.close(&log);
        for (i, size) in sizes.iter().enumerate() {
            eprintln!("[ptp] frame {:02}: {} bytes", i + 1, size);
        }
        eprintln!(
            "[ptp] 30 frames in {:.2} s: {:.1} fps, sizes {}..{} bytes",
            elapsed.as_secs_f64(),
            30.0 / elapsed.as_secs_f64(),
            sizes.iter().min().unwrap(),
            sizes.iter().max().unwrap()
        );
    }

    /// The focus drive payload layout: control code, a type word of 2,
    /// the mode at offset 8, the same fixed-offset layout the property
    /// channel uses.
    #[test]
    fn the_focus_drive_payload_lays_out_like_gphoto_speaks_it() {
        let p = encode_focus_drive_payload(0x0004);
        assert_eq!(p.len(), 10);
        assert_eq!(u32::from_le_bytes(p[0..4].try_into().unwrap()), 0x0301_0011);
        assert_eq!(u32::from_le_bytes(p[4..8].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(p[8..10].try_into().unwrap()), 4);
    }

    #[test]
    fn the_af_wire_facts_stay_named() {
        // Verified on the DC-S5 (2026-08-26): 0x9405 takes the one-shot
        // code as its parameter, and the body reports the result as
        // 0xC104. The names keep a bug report readable.
        assert_eq!(panasonic::af::AF_ONE_SHOT, 0x0300_0024);
        assert_eq!(panasonic::EV_AF_RESULT, 0xC104);
        assert!(operation_name(panasonic::OP_AF_AE).contains("AF/AE"));
        assert!(event_name(panasonic::EV_AF_RESULT).contains("AF result"));
    }

    /// Focus control's hardware probe. Run with `cargo test -p heeler-desktop --lib
    /// panasonic_focus_drive -- --ignored --nocapture` and a Panasonic body in PC(Tether)
    /// mode with a lens fitted, MF on the body or lens. WATCH THE LENS and note which modes
    /// move it, how far, and whether AF runs. It never fires the shutter.
    ///
    /// Run 1 (2026-08-26, DC-S5, no stream): every mode answered 0x201D
    /// (invalid parameter) and both AF control codes answered general
    /// error. A refusal that uniform is a missing context, not a bad
    /// table: LUMIX Tether drives focus over the live view stream, so
    /// run 2 drives with the stream running.
    ///
    /// Run 2 (2026-08-26, stream on, MF): modes 1, 3, 4 accepted; 2,
    /// 5, 6, 7, 8 refused; AF still refused both control codes. the
    /// owner saw near movement only, which is positional: a lens
    /// already at the far stop accepts a far drive and shows nothing.
    ///
    /// Run 3 (2026-08-26, stream on, MF, lens at mid-range): every mode
    /// 1..4 accepted and both directions moved. Settled table: 1 =
    /// farther big, 2 = farther small, 3 = closer small, 4 = closer big.
    ///
    /// Run 4 (2026-08-26, stream on, body in AF): both 0x9405 control
    /// codes refused with general error even with the body in AF, so
    /// 0x9405 is not the DC-S5's standalone AF trigger in any context
    /// probed. AF during capture works (the body focuses itself when in
    /// AF); what run 4 rules out is a software AF button over 0x9405.
    ///
    /// Run 5 is the last wire path on record: ptp.h declares a
    /// RecCtrlAFAE property family (0x03000020 command base, 0x03000024
    /// AF one-shot) that gphoto never exercises, so the probe tries it
    /// over the property channel. SET THE BODY TO AF; the stream starts
    /// itself. Watch the lens for an AF sweep per line: the family
    /// descriptor read, AF one-shot as a bare command write (no value),
    /// AF one-shot with an explicit trigger value, and 0x9405 with the
    /// family codes as parameters. After the last attempt the probe
    /// listens on the interrupt pipe: a body that really ran AF reports
    /// the result as a vendor event, while a body that only
    /// acknowledged the command stays silent. Wire evidence plus the
    /// visible sweep together decide; an accepted line with neither
    /// closes the standalone-AF question on this body.
    ///
    /// Run 5 (2026-08-26, stream on, body in AF): the family descriptor
    /// is not listable, both property-channel writes answered invalid
    /// parameter, 0x9405 with the command base answered general error,
    /// and 0x9405 with the AF one-shot code 0x03000024 was ACCEPTED.
    /// Whether the lens swept on that line is the deciding observation;
    /// the event listen exists so the wire answers it too.
    #[test]
    #[ignore]
    fn panasonic_focus_drive() {
        let (probes, _) = probe_cameras();
        let Some(p) = probes.iter().find(|p| p.verdict == CameraVerdict::PtpCapable) else {
            panic!("no PTP-capable camera on the bus");
        };
        let log = |m: &str| eprintln!("[ptp] {m}");
        let mut conn = CameraConnection::connect(&p.key, &log).expect("connect");
        if conn.info.vendor_extension_id != panasonic::VENDOR_EXTENSION {
            panic!("the connected body is not a Panasonic tether body");
        }
        conn.start_liveview().expect("start live view");
        eprintln!("[ptp] stream on; SET THE BODY TO AF, then watch for an AF sweep per line");
        for param in [0x0300_0011u32, 0x0301_0011] {
            match conn.command(panasonic::OP_AF_AE, &[param], None) {
                Ok(_) => eprintln!("[ptp] AF/AE with param {param:#010x}: accepted"),
                Err(e) => eprintln!("[ptp] AF/AE with param {param:#010x}: {e}"),
            }
            std::thread::sleep(Duration::from_millis(1200));
        }
        // The RecCtrlAFAE property family over the property channel.
        // The descriptor read answers whether the body exposes the
        // family at all; the writes try AF one-shot as a bare command
        // and with an explicit trigger value; the last pair tries
        // 0x9405 with the family codes as its parameter.
        match conn.list_property(panasonic::af::CMD_BASE) {
            Ok(d) => eprintln!(
                "[ptp] AF/AE family descriptor: current {:#x}, allowed {:?}",
                d.current, d.allowed
            ),
            Err(e) => eprintln!("[ptp] AF/AE family descriptor: {e}"),
        }
        let mut bare = Vec::new();
        bare.extend_from_slice(&panasonic::af::AF_ONE_SHOT.to_le_bytes());
        bare.extend_from_slice(&0u32.to_le_bytes());
        match conn.command_data_out(panasonic::OP_SET_PROPERTY, &[panasonic::af::AF_ONE_SHOT], &bare) {
            Ok(_) => eprintln!("[ptp] AF one-shot, bare write: accepted"),
            Err(e) => eprintln!("[ptp] AF one-shot, bare write: {e}"),
        }
        std::thread::sleep(Duration::from_millis(1200));
        match conn.set_property(panasonic::af::AF_ONE_SHOT, 4, 1) {
            Ok(_) => eprintln!("[ptp] AF one-shot, value 1: accepted"),
            Err(e) => eprintln!("[ptp] AF one-shot, value 1: {e}"),
        }
        std::thread::sleep(Duration::from_millis(1200));
        for param in [panasonic::af::CMD_BASE, panasonic::af::AF_ONE_SHOT] {
            match conn.command(panasonic::OP_AF_AE, &[param], None) {
                Ok(_) => eprintln!("[ptp] AF/AE with param {param:#010x}: accepted"),
                Err(e) => eprintln!("[ptp] AF/AE with param {param:#010x}: {e}"),
            }
            std::thread::sleep(Duration::from_millis(1200));
        }
        // A body that really ran AF says so on the interrupt pipe (a
        // focus result event follows the sweep); a body that only
        // acknowledged the command stays silent. Whatever arrived
        // during the pauses above is still buffered on the pipe.
        eprintln!("[ptp] listening 3s on the interrupt pipe; an event here is the body reporting the AF result");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Some((code, param)) = conn.read_event(Duration::from_millis(400), &log) {
                eprintln!("[ptp] post-AF event 0x{code:04X} param {param:#010x}");
            }
        }
        conn.stop_liveview().expect("stop live view");
        conn.close(&log);
    }
}
