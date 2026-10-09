# RAW support matrix

Corpus: a local copy of the raw.pixls.us sample archive  
LibRaw 0.22.2 (libjpeg linked, zlib linked), develop at half size, plus the app's decode_any at full size, 2016 files in 743s.

## What the app would show

| Verdict | Files | Meaning |
|---|---:|---|
| develop | 1916 | LibRaw develops it and the result passes the noise gate |
| jxl develop | 1 | JPEG XL DNG, decoded by Heeler's own path |
| preview fallback | 29 | develop failed or looked like noise; the app silently shows the embedded JPEG |
| error shown | 11 | develop failed and there is no preview to fall back on |
| image path | 20 | extension the catalog lists but LibRaw is not asked about (TIFF) |
| not indexed | 39 | extension the catalog never lists, so the file is invisible |

## By extension

| Ext | Files | Catalog | LibRaw asked | Develops | Fails | Noise | Preview only |
|---|---:|---|---|---:|---:|---:|---:|
| 3fr | 11 | yes | yes | 11 | 0 | 0 | 0 |
| ari | 1 | no | no | 0 | 1 | 0 | 0 |
| arq | 1 | yes | yes | 1 | 0 | 0 | 0 |
| arw | 206 | yes | yes | 202 | 4 | 0 | 4 |
| cam | 2 | no | no | 0 | 2 | 0 | 0 |
| cr2 | 142 | yes | yes | 142 | 0 | 0 | 0 |
| cr3 | 110 | yes | yes | 110 | 0 | 0 | 0 |
| crw | 51 | yes | yes | 48 | 3 | 0 | 2 |
| dcr | 5 | yes | yes | 5 | 0 | 0 | 0 |
| dng | 262 | yes | yes | 259 | 3 | 0 | 2 |
| erf | 3 | yes | yes | 3 | 0 | 0 | 0 |
| fff | 11 | yes | yes | 11 | 0 | 0 | 0 |
| gpr | 17 | no | no | 0 | 17 | 0 | 0 |
| iiq | 35 | yes | yes | 35 | 0 | 0 | 0 |
| kdc | 9 | yes | yes | 9 | 0 | 0 | 0 |
| lri | 1 | no | no | 0 | 1 | 0 | 0 |
| mdc | 1 | yes | yes | 1 | 0 | 0 | 0 |
| mef | 1 | yes | yes | 1 | 0 | 0 | 0 |
| mos | 4 | yes | yes | 4 | 0 | 0 | 0 |
| mrw | 14 | yes | yes | 14 | 0 | 0 | 0 |
| nef | 277 | yes | yes | 263 | 14 | 0 | 14 |
| nrw | 12 | yes | yes | 12 | 0 | 0 | 0 |
| orf | 93 | yes | yes | 93 | 0 | 0 | 0 |
| ori | 19 | yes | yes | 19 | 0 | 0 | 0 |
| pef | 42 | yes | yes | 42 | 0 | 0 | 0 |
| raf | 151 | yes | yes | 151 | 0 | 0 | 0 |
| raw | 49 | yes | yes | 34 | 11 | 4 | 5 |
| rw2 | 398 | yes | yes | 396 | 2 | 0 | 2 |
| rwl | 20 | yes | yes | 20 | 0 | 0 | 0 |
| sr2 | 1 | yes | yes | 1 | 0 | 0 | 0 |
| srf | 1 | yes | yes | 1 | 0 | 0 | 0 |
| srw | 27 | yes | yes | 27 | 0 | 0 | 0 |
| sti | 1 | yes | yes | 1 | 0 | 0 | 0 |
| tif | 20 | yes | no | 20 | 0 | 0 | 0 |
| x3f | 18 | no | no | 0 | 18 | 0 | 0 |

## By make folder

| Folder | Files | Develops | Preview only | Error | Not indexed |
|---|---:|---:|---:|---:|---:|
| Adobe DNG Converter | 6 | 6 | 0 | 0 | 0 |
| Apple | 6 | 6 | 0 | 0 | 0 |
| Arashi Vision | 1 | 1 | 0 | 0 | 0 |
| Arri | 1 | 0 | 0 | 0 | 1 |
| Autel | 1 | 1 | 0 | 0 | 0 |
| Autel Robotics | 1 | 1 | 0 | 0 | 0 |
| Blackmagic | 9 | 9 | 0 | 0 | 0 |
| Blackmagic Design | 1 | 1 | 0 | 0 | 0 |
| Canon | 359 | 353 | 2 | 1 | 0 |
| Casio | 2 | 0 | 0 | 0 | 2 |
| DJI | 8 | 8 | 0 | 0 | 0 |
| Epson | 3 | 3 | 0 | 0 | 0 |
| Eyedeas | 1 | 1 | 0 | 0 | 0 |
| FIMI | 1 | 1 | 0 | 0 | 0 |
| Fujifilm | 152 | 152 | 0 | 0 | 0 |
| Gitup | 5 | 5 | 0 | 0 | 0 |
| GoPro | 17 | 0 | 0 | 0 | 17 |
| Google | 7 | 7 | 0 | 0 | 0 |
| HMD Global | 1 | 1 | 0 | 0 | 0 |
| HTC | 1 | 1 | 0 | 0 | 0 |
| HUAWEI | 18 | 18 | 0 | 0 | 0 |
| Hasselblad | 25 | 25 | 0 | 0 | 0 |
| ImBack | 1 | 0 | 0 | 1 | 0 |
| KONICA MINOLTA | 2 | 2 | 0 | 0 | 0 |
| KanDao | 4 | 4 | 0 | 0 | 0 |
| Kodak | 30 | 25 | 0 | 0 | 0 |
| LG | 9 | 9 | 0 | 0 | 0 |
| Leaf | 8 | 8 | 0 | 0 | 0 |
| Leica | 37 | 37 | 0 | 0 | 0 |
| Leica Camera AG | 2 | 2 | 0 | 0 | 0 |
| Light | 2 | 1 | 0 | 0 | 1 |
| MADV | 1 | 1 | 0 | 0 | 0 |
| Mamiya | 1 | 1 | 0 | 0 | 0 |
| Microsoft | 1 | 1 | 0 | 0 | 0 |
| Minolta | 12 | 12 | 0 | 0 | 0 |
| Minolta Co., Ltd. | 1 | 1 | 0 | 0 | 0 |
| NIKON CORPORATION | 43 | 35 | 8 | 0 | 0 |
| Nikon | 248 | 242 | 6 | 0 | 0 |
| Nokia | 2 | 2 | 0 | 0 | 0 |
| OLYMPUS IMAGING CORP. | 1 | 1 | 0 | 0 | 0 |
| OM Digital Solutions | 14 | 14 | 0 | 0 | 0 |
| OM System | 20 | 20 | 0 | 0 | 0 |
| Olympus | 77 | 77 | 0 | 0 | 0 |
| OnePlus | 4 | 4 | 0 | 0 | 0 |
| Panasonic | 409 | 407 | 2 | 0 | 0 |
| Paralenz | 2 | 0 | 0 | 2 | 0 |
| Parrot | 3 | 3 | 0 | 0 | 0 |
| Pentax | 78 | 78 | 0 | 0 | 0 |
| Phase One | 40 | 28 | 0 | 0 | 0 |
| Phase One AS | 3 | 3 | 0 | 0 | 0 |
| Plustek | 2 | 2 | 0 | 0 | 0 |
| Polaroid | 1 | 0 | 0 | 0 | 1 |
| RaspberryPi | 10 | 5 | 5 | 0 | 0 |
| Realme | 1 | 1 | 0 | 0 | 0 |
| Ricoh | 7 | 7 | 0 | 0 | 0 |
| SAMSUNG TECHWIN | 1 | 1 | 0 | 0 | 0 |
| SJCam | 6 | 0 | 0 | 6 | 0 |
| Samsung | 50 | 49 | 1 | 0 | 0 |
| Sigma | 26 | 9 | 0 | 0 | 17 |
| Sinarback | 1 | 1 | 0 | 0 | 0 |
| Sony | 208 | 204 | 4 | 0 | 0 |
| XIAOYI | 3 | 3 | 0 | 0 | 0 |
| Xiaomi | 8 | 8 | 0 | 0 | 0 |
| Xiro | 1 | 0 | 0 | 1 | 0 |
| YI TECHNOLOGY | 1 | 1 | 0 | 0 | 0 |
| Yuneec | 2 | 2 | 0 | 0 | 0 |
| asus | 2 | 2 | 0 | 0 | 0 |
| bq | 1 | 1 | 0 | 0 | 0 |
| moto g8plus | 1 | 0 | 1 | 0 | 0 |
| motorola | 3 | 3 | 0 | 0 | 0 |

## Indexed files that do not develop

These open in the app today, but not as a develop.

| Verdict | Camera | File | LibRaw said |
|---|---|---|---|
| preview fallback |  | Canon/IXY 220F/canon_ixy_220f.CRW | libraw: Unsupported file format or not RAW file (-2) |
| error shown |  | Canon/PowerShot G7 X/CANON_G7X_CHDK_CRW_6739.CRW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback |  | Canon/Powershot A620/Portulaca_1216.CRW | libraw: Unsupported file format or not RAW file (-2) |
| error shown |  | ImBack/ImB35mm/ttx.raw | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_16_9.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_1_1.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_DX.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_FX.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_Star_16_9.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_Star_1_1.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_Star_DX.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z6_3 | NIKON CORPORATION/NIKON Z6_3/Nikon_Z6__3_High_Efficiency_Star_FX.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z 8 | Nikon/Z 8/Nikon_Z8_high_efficiency_low.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z 8 | Nikon/Z 8/Nikon_Z8_raw_high_efficiency_hight.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z 9 | Nikon/Z 9/Nikon_-_NIKON_Z_9_-_14bit_compressed_(Lossy_High_Efficiency).NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z 9 | Nikon/Z 9/Nikon_-_NIKON_Z_9_-_14bit_compressed_(Lossy_High_Efficiency_Star).NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z f | Nikon/Z f/DSC_0042.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | NIKON Z f | Nikon/Z f/DSC_0043.NEF | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | Panasonic DC-S1RM2 | Panasonic/DC-S1RM2/P1000450.RW2 | libraw: Input/output error (-100009) |
| preview fallback | Panasonic DMC-FZ38 | Panasonic/DMC-FZ38/Panasonic_DMC-FZ38_-3_2.RW2 | libraw: Input/output error (-100009) |
| error shown |  | Paralenz/+/IMG_0005.RAW | libraw: Unsupported file format or not RAW file (-2) |
| error shown |  | Paralenz/Dive Camera/IMG_0005.RAW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | RaspberryPi RP_imx477 | RaspberryPi/RP_imx477/pi.raw | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | RaspberryPi RP_imx477 | RaspberryPi/RP_imx477/pi_hq_picamera.raw | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | RaspberryPi RP_imx477 | RaspberryPi/RP_imx477/pi_hq_raspistill.raw | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | RaspberryPi RP_ov5647 | RaspberryPi/RP_ov5647/Pi_V1.3.raw | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | RaspberryPi RP_ov5647 | RaspberryPi/RP_ov5647/Pi_V1.3_picamera.raw | libraw: Unsupported file format or not RAW file (-2) |
| error shown |  | SJCam/5000X Elite/2015_0101_035947_003.RAW | decoded, but the result looks like noise |
| error shown |  | SJCam/5000X Elite/2016_0104_005847_665To_send.RAW | decoded, but the result looks like noise |
| error shown |  | SJCam/M20/2016_0101_013059_001.RAW | decoded, but the result looks like noise |
| error shown |  | SJCam/SJ6 LEGEND/2018_0107_140544_001.RAW | decoded, but the result looks like noise |
| error shown |  | SJCam/SJ6 LEGEND/2018_0107_140610_003.RAW | libraw: Unsupported file format or not RAW file (-2) |
| error shown |  | SJCam/SJ6 LEGEND/2018_0107_140646_005.RAW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | samsung SM-G973U | Samsung/SM-G973U/20200402_181931.dng | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | SONY ILCE-7M5 | Sony/ILCE-7M5/apcs_compressed_hq.ARW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | SONY ILCE-7M5 | Sony/ILCE-7M5/apsc_compressed.ARW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | SONY ILCE-7M5 | Sony/ILCE-7M5/full_compressed.ARW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback | SONY ILCE-7M5 | Sony/ILCE-7M5/full_compressed_HQ.ARW | libraw: Unsupported file format or not RAW file (-2) |
| error shown |  | Xiro/Xplorer V/2017_0908_092308_001.RAW | libraw: Unsupported file format or not RAW file (-2) |
| preview fallback |  | moto g8plus/moto g8plus/IMG_20200621_212547364.dng | libraw: Unsupported file format or not RAW file (-2) |

## Not indexed, but LibRaw develops them

What listing the extension in the catalog would gain.

| Ext | Develops | Of | Cameras |
|---|---:|---:|---|

## Where the prediction and decode_any disagree

| Verdict | decode_any | Camera | File |
|---|---|---|---|
| preview fallback | fail: image decode/encode failed: Format error decoding Jpeg: "Bad DRI length, Corrupt JPEG": Canon/IXY 220F/canon_ixy_220f.CRW |  | Canon/IXY 220F/canon_ixy_220f.CRW |
| preview fallback | fail: image decode/encode failed: Format error decoding Jpeg: Error parsing SOS Segment. Reason:Bad SOS length 22610,corrupt jpeg: Canon/Powershot A620/Portulaca_1216.CRW |  | Canon/Powershot A620/Portulaca_1216.CRW |

## Slowest develops

| ms | MB | Camera | File |
|---:|---:|---|---|
| 3527 | 67.6 | FUJIFILM GFX100 II | Fujifilm/GFX100 II/_DSF0265.RAF (5831x4373) |
| 3506 | 69.6 | FUJIFILM GFX100S | Fujifilm/GFX100S/Fujifilm-GFX100S-16bits-compress-4_3.RAF (5831x4373) |
| 3415 | 68.6 | FUJIFILM GFX100S II | Fujifilm/GFX100S II/_DSF0002.RAF (5831x4373) |
| 3275 | 69.4 | FUJIFILM GFX100RF | Fujifilm/GFX100RF/DSCF0076.RAF (5831x4373) |
| 2806 | 59.3 | FUJIFILM GFX100 II | Fujifilm/GFX100 II/_DSF0266.RAF (5831x4373) |
| 2711 | 61.1 | FUJIFILM GFX100RF | Fujifilm/GFX100RF/DSCF0092.RAF (5831x4373) |
| 2696 | 61.3 | FUJIFILM GFX100S | Fujifilm/GFX100S/Fujifilm-GFX100S-14bits-compress-4_3.RAF (5831x4373) |
| 2684 | 60.2 | FUJIFILM GFX100S II | Fujifilm/GFX100S II/_DSF0006.RAF (5831x4373) |
| 2431 | 160.6 | Phase One IQ4 150MP | Phase One/IQ4 150MP/IQ4_150MP_L_14.iiq (7102x5326) |
| 2424 | 201.2 | Phase One IQ4 150MP | Phase One/IQ4 150MP/IQ4_150MPIIQ_L_16bit.iiq (7102x5326) |
