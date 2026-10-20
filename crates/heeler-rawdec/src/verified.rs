//! The cameras whose DNGs the develop has been verified on: every file of
//! theirs in the sample corpus developed the same as
//! LibRaw's develop, to the bit, at every stage the tests compare
//! (heeler-raw's rust_decoder_corpus.rs). A camera's DNG writer has its
//! own habits (margins, levels, tile layouts), so a camera joins this
//! list only once its files have been compared.

/// Make and Model as IFD0 of the DNG gives them.
/// Generated from rustdiff over the corpus of 2026-10-19 (2020 files).
const CAMERAS: &[(&str, &str)] = &[
    ("Arashi Vision", "Insta360 One2"),
    ("Autel", "Model 323"),
    ("Autel Robotics", "XB015"),
    ("Canon", "Canon EOS 60D"),
    ("Canon", "Canon EOS 7D Mark II"),
    ("Canon", "Canon PowerShot A560"),
    ("Canon", "Canon PowerShot G1 X"),
    ("Canon", "Canon PowerShot G7 X"),
    ("Canon", "Canon PowerShot S100"),
    ("Canon", "Canon PowerShot SX50 HS"),
    ("Canon", "Canon PowerShot SX60 HS"),
    ("Canon", "Canon PowerShot SX710 HS"),
    ("DJI", "FC350"),
    ("DJI", "FC4382"),
    ("DJI", "FC9287"),
    ("Eyedeas", "E1"),
    ("KanDao", "QooCam"),
    ("Kandao", "QooCam 8K"),
    ("LEICA CAMERA AG", "LEICA CL"),
    ("LEICA CAMERA AG", "LEICA Q (Typ 116)"),
    ("LEICA CAMERA AG", "LEICA Q2"),
    ("LEICA CAMERA AG", "LEICA SL (Typ 601)"),
    ("LEICA CAMERA AG", "LEICA X2"),
    ("LG Mobile", "LG-F800K"),
    ("LG Mobile", "LG-H815"),
    ("LG Mobile", "LG-H870"),
    ("LG Mobile", "VS995"),
    ("LGE", "LG-D855"),
    ("Leica Camera AG", "LEICA M (Typ 240)"),
    ("Leica Camera AG", "LEICA M10"),
    ("Leica Camera AG", "LEICA M10-R"),
    ("Leica Camera AG", "M8 Digital Camera"),
    ("Leica Camera AG", "M9 Digital Camera"),
    ("NIKON CORPORATION", "NIKON D80"),
    ("OnePlus", "ONEPLUS A3003"),
    ("OnePlus", "ONEPLUS A5000"),
    ("OnePlus", "ONEPLUS A6003"),
    ("PARROT", "Bebop 2"),
    ("PARROT", "Bebop Drone"),
    ("PENTAX", "PENTAX K-01"),
    ("PENTAX", "PENTAX K-30"),
    ("PENTAX", "PENTAX K-50"),
    ("PENTAX", "PENTAX K-500"),
    ("PENTAX", "PENTAX Q"),
    ("PENTAX", "PENTAX Q7"),
    ("PENTAX RICOH IMAGING", "PENTAX MX-1"),
    ("Panasonic", "DMC-LX1"),
    ("RICOH", "GR DIGITAL 2"),
    ("RICOH", "GXR"),
    ("RICOH IMAGING COMPANY, LTD.", "GR"),
    ("RICOH IMAGING COMPANY, LTD.", "GR II"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX 645Z"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-1"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-1 Mark II"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-3"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-3 II"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-3 Mark III"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-70"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-S1"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-S2"),
    ("RICOH IMAGING COMPANY, LTD.", "PENTAX KP"),
    ("RICOH IMAGING COMPANY, LTD.", "RICOH GR III"),
    ("RICOH IMAGING COMPANY, LTD.", "RICOH GR IIIx"),
    ("RaspberryPi", "RP_imx477"),
    ("Xiaomi", "HM NOTE 1LTE"),
    ("Xiaomi", "MI MAX"),
    ("YI TECHNOLOGY", "M1"),
    ("Yuneec", "CGO3"),
    ("Yuneec", "CGO3P"),
    ("asus", "ASUS_Z01KD"),
];

pub fn camera(make: &str, model: &str) -> bool {
    CAMERAS.iter().any(|&(m, n)| m == make && n == model)
}

pub fn cameras() -> &'static [(&'static str, &'static str)] {
    CAMERAS
}
