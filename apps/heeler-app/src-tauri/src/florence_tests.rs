//! Florence-2's desktop command: the refusal in words when the model is
//! not installed, the checks before a model is loaded, the cache key,
//! and the task shape the frontend sends. No model runs here; the
//! real-weight test is heeler-vision's ignored
//! florence_real_model_names_the_cat.
use super::*;
use std::sync::atomic::AtomicBool;

#[test]
fn the_command_refuses_in_words_when_the_model_is_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    let stop = AtomicBool::new(false);
    let tasks = [heeler_vision::FlorenceTask::Caption];
    let err = florence_describe_at(dir.path(), b"not even a frame", &tasks, false, &stop).unwrap_err();
    assert_eq!(err, FLORENCE_NOT_INSTALLED);
    assert!(err.contains("Preferences, Assistant"), "{err}");
    assert!(!err.to_lowercase().contains("pro"), "Florence-2 is free: {err}");
    // A half-installed model (one file, the wrong bytes) is not installed.
    let model = heeler_vision::model_dir(dir.path(), &heeler_vision::FLORENCE_2);
    std::fs::create_dir_all(&model).unwrap();
    std::fs::write(model.join("vision_encoder.onnx"), b"not the weights").unwrap();
    assert_eq!(florence_describe_at(dir.path(), b"", &tasks, false, &stop).unwrap_err(), FLORENCE_NOT_INSTALLED);
}

#[test]
fn a_bad_phrase_or_frame_is_refused_before_a_model_loads() {
    // `verified` stands for an installed model; the checks answer
    // before the (absent) weights are opened.
    let dir = tempfile::tempdir().unwrap();
    let stop = AtomicBool::new(false);
    let empty = [heeler_vision::FlorenceTask::Grounding { phrase: "   ".into() }];
    assert!(florence_describe_at(dir.path(), b"", &empty, true, &stop).unwrap_err().contains("phrase"));
    let long = [heeler_vision::FlorenceTask::Grounding { phrase: "x".repeat(201) }];
    assert!(florence_describe_at(dir.path(), b"", &long, true, &stop).unwrap_err().contains("phrase"));
    let caption = [heeler_vision::FlorenceTask::Caption];
    let err = florence_describe_at(dir.path(), b"not an image", &caption, true, &stop).unwrap_err();
    assert!(err.starts_with("The frame on screen could not be read"), "{err}");
    assert!(florence_describe_at(dir.path(), b"", &[], true, &stop).unwrap().is_empty());
}

#[test]
fn answers_are_cached_by_frame_task_and_weights_version() {
    let caption = heeler_vision::FlorenceTask::Caption;
    let face = heeler_vision::FlorenceTask::Grounding { phrase: "the cheetah's face".into() };
    let a = florence_answer_key("aa", &caption);
    assert_ne!(a, florence_answer_key("bb", &caption));
    assert_ne!(a, florence_answer_key("aa", &face));
    assert!(a.ends_with(heeler_vision::FLORENCE_2.version));
}

#[test]
fn the_tasks_read_as_the_frontend_writes_them_and_the_model_is_listed() {
    let tasks: Vec<heeler_vision::FlorenceTask> = serde_json::from_str(
        r#"[{"task":"caption"},{"task":"detailed_caption"},{"task":"objects"},{"task":"grounding","phrase":"the sky"}]"#,
    )
    .unwrap();
    assert_eq!(tasks[3], heeler_vision::FlorenceTask::Grounding { phrase: "the sky".into() });
    assert_eq!(tasks[1].token(), "<DETAILED_CAPTION>");
    assert!(RELOCATABLE_MODELS.iter().any(|s| s.id == "florence_2_base"));
    let region = heeler_vision::FlorenceRegion { label: "sky".into(), x0: 0.0, y0: 0.0, x1: 1.0, y1: 0.4 };
    let answer = heeler_vision::FlorenceAnswer { text: "sky".into(), regions: vec![region], truncated: false };
    let json = serde_json::to_value(&answer).unwrap();
    assert_eq!(json["regions"][0]["y1"], serde_json::json!(0.4f32));
}
