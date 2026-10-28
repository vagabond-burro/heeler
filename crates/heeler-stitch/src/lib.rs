//! Panorama stitching.
//!
//! Written from Brown and Lowe's "Automatic Panoramic Image Stitching
//! using Invariant Features", which is the paper the whole field is
//! built on and the one Heeler follows. Written rather than imported
//! because the two obvious sources are both closed to this project:
//! Hugin and enblend are GPL, and Heeler takes no GPL-family
//! dependencies, while OpenCV would be an enormous dependency to carry
//! for what turns out to be a few thousand lines of arithmetic.
//!
//! The pipeline, in the order the modules appear:
//!
//! 1. Features: scale and rotation invariant keypoints per image.
//! 2. Matching: nearest neighbors, then RANSAC on a homography, then a
//!    probabilistic decision about whether two images really overlap.
//! 3. Bundle adjustment: all cameras solved together as rotations and a
//!    focal length, so error spreads evenly instead of piling up at the
//!    end of a chain.
//! 4. Compositing: gain compensation, seams cut where the frames agree,
//!    and multi-band blending onto the output surface.
//! 5. Cropping: the largest rectangle the panorama fills, offered as its
//!    starting crop.
//!
//! What makes it automatic is step 2: the panorama is not told which
//! images belong together or in what order. It is handed a pile of
//! photographs and works out which ones overlap, discarding the ones that
//! do not.

pub mod bundle;
pub mod composite;
pub mod crop;
pub mod features;
pub mod geom;
pub mod gray;
pub mod kdtree;
pub mod lens;
pub mod matching;
pub mod pipeline;
pub mod seam;

pub use bundle::Camera;
pub use crop::{auto_crop, auto_crop_at_ratio, CropRect};
pub use composite::{composite, composite_with_control, composite_with_progress, CompositeOpts, Frame, Surface};
pub use features::{detect, Feature, Keypoint};
pub use gray::Gray;
pub use lens::Lens;
pub use pipeline::{stitch, stitch_with_control, stitch_with_progress, StitchError, StitchOpts, Stitched, REGISTER_EDGE};
