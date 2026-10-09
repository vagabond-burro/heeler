//! The `.heelerproj` directory format.
//!
//! Layout:
//! ```text
//! MyProject.heelerproj/
//!   project.json                     manifest
//!   graphs/collections/<id>.json
//!   graphs/images/<image>/<ver>.json
//!   graphs/images/<image>/<ver>.journal.json   command journal for recovery
//!   groups/<name>.heelergroup
//!   cache/                           disposable, never required
//! ```
//! Source image files are referenced, never copied or modified. Everything
//! under cache/ is reconstructible; deleting it must never lose user work.

pub mod atomic;

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use heeler_commands::{CommandError, CommandProcessor, JournalEntry};
use heeler_graph::group::{GroupDef, GroupError, GROUP_EXTENSION};
use heeler_graph::{Graph, GraphError, Registry, Section};

pub const PROJECT_SCHEMA_VERSION: u32 = 1;
pub const PROJECT_EXTENSION: &str = "heelerproj";
pub const MANIFEST_FILE: &str = "project.json";

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid project file: {0}")]
    Format(#[from] serde_json::Error),
    #[error(transparent)]
    Graph(#[from] GraphError),
    #[error(transparent)]
    Group(#[from] GroupError),
    #[error(transparent)]
    Command(#[from] CommandError),
    #[error("unsupported project schema version {0}")]
    SchemaVersion(u32),
    #[error("image '{0}' not found in project")]
    ImageNotFound(String),
    #[error("version '{version}' not found on image '{image}'")]
    VersionNotFound { image: String, version: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageRecord {
    pub id: String,
    /// Absolute path as last seen; used first when resolving.
    pub source_abs: String,
    /// Path relative to the project root, when the source lives under it.
    /// Lets projects move together with their images.
    pub source_rel: Option<String>,
    pub active_version: String,
    pub versions: Vec<VersionRecord>,
    next_version: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub name: String,
    pub images: Vec<ImageRecord>,
    next_image_id: u64,
}

pub struct Project {
    root: PathBuf,
    pub manifest: Manifest,
}

impl Project {
    pub fn create(root: &Path, name: &str) -> Result<Project, ProjectError> {
        fs::create_dir_all(root.join("graphs").join("images"))?;
        fs::create_dir_all(root.join("graphs").join("collections"))?;
        fs::create_dir_all(root.join("groups"))?;
        fs::create_dir_all(root.join("cache"))?;
        let project = Project {
            root: root.to_path_buf(),
            manifest: Manifest {
                schema_version: PROJECT_SCHEMA_VERSION,
                name: name.to_string(),
                images: Vec::new(),
                next_image_id: 1,
            },
        };
        project.save_manifest()?;
        Ok(project)
    }

    pub fn open(root: &Path) -> Result<Project, ProjectError> {
        let manifest: Manifest =
            serde_json::from_str(&fs::read_to_string(root.join(MANIFEST_FILE))?)?;
        if manifest.schema_version != PROJECT_SCHEMA_VERSION {
            return Err(ProjectError::SchemaVersion(manifest.schema_version));
        }
        Ok(Project {
            root: root.to_path_buf(),
            manifest,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn save_manifest(&self) -> Result<(), ProjectError> {
        atomic::write_json(
            self.root.join(MANIFEST_FILE),
            serde_json::to_string_pretty(&self.manifest)?,
        )?;
        Ok(())
    }

    pub fn image(&self, id: &str) -> Result<&ImageRecord, ProjectError> {
        self.manifest
            .images
            .iter()
            .find(|i| i.id == id)
            .ok_or_else(|| ProjectError::ImageNotFound(id.to_string()))
    }

    fn image_mut(&mut self, id: &str) -> Result<&mut ImageRecord, ProjectError> {
        self.manifest
            .images
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or_else(|| ProjectError::ImageNotFound(id.to_string()))
    }

    /// Registers a source image and creates its default graph: an Image
    /// Source node wired straight to an Output node. The default two-node
    /// graph is the "unedited image" state.
    pub fn add_image(&mut self, source: &Path, registry: &Registry) -> Result<String, ProjectError> {
        let id = format!("img_{}", self.manifest.next_image_id);
        self.manifest.next_image_id += 1;

        let version = VersionRecord {
            id: "v1".to_string(),
            name: "Original".to_string(),
        };
        let graph_id = format!("{id}_v1");
        let mut graph = Graph::new(&graph_id);
        graph.add_node(registry.instantiate("heeler.image_source", "src", Section::RawFoundation)?)?;
        graph.add_node(registry.instantiate("heeler.output", "out", Section::Output)?)?;
        graph.connect("src", "out", "out", "in")?;

        let source_rel = source
            .strip_prefix(&self.root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        let record = ImageRecord {
            id: id.clone(),
            source_abs: source.to_string_lossy().to_string(),
            source_rel,
            active_version: "v1".to_string(),
            versions: vec![version],
            next_version: 2,
        };
        self.manifest.images.push(record);
        self.save_graph(&id, "v1", &graph)?;
        self.save_manifest()?;
        Ok(id)
    }

    /// Resolves the source file: the stored absolute path if it still
    /// exists, else the project-relative path, else None (UI shows the
    /// "Locate file" state).
    pub fn resolve_source(&self, image: &str) -> Result<Option<PathBuf>, ProjectError> {
        let record = self.image(image)?;
        let abs = PathBuf::from(&record.source_abs);
        if abs.exists() {
            return Ok(Some(abs));
        }
        if let Some(rel) = &record.source_rel {
            let candidate = self.root.join(rel);
            if candidate.exists() {
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }

    fn image_dir(&self, image: &str) -> PathBuf {
        self.root.join("graphs").join("images").join(image)
    }

    pub fn graph_path(&self, image: &str, version: &str) -> PathBuf {
        self.image_dir(image).join(format!("{version}.json"))
    }

    pub fn journal_path(&self, image: &str, version: &str) -> PathBuf {
        self.image_dir(image).join(format!("{version}.journal.json"))
    }

    pub fn save_graph(&self, image: &str, version: &str, graph: &Graph) -> Result<(), ProjectError> {
        fs::create_dir_all(self.image_dir(image))?;
        atomic::write_json(
            self.graph_path(image, version),
            serde_json::to_string_pretty(graph)?,
        )?;
        Ok(())
    }

    pub fn load_graph(&self, image: &str, version: &str) -> Result<Graph, ProjectError> {
        let path = self.graph_path(image, version);
        if !path.exists() {
            return Err(ProjectError::VersionNotFound {
                image: image.to_string(),
                version: version.to_string(),
            });
        }
        Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
    }

    /// Creates a new version by copying the graph of `from_version`.
    /// Versions are independent branches; there is no merging.
    pub fn add_version(
        &mut self,
        image: &str,
        name: &str,
        from_version: &str,
    ) -> Result<String, ProjectError> {
        let mut graph = self.load_graph(image, from_version)?;
        let record = self.image_mut(image)?;
        let ver_id = format!("v{}", record.next_version);
        record.next_version += 1;
        record.versions.push(VersionRecord {
            id: ver_id.clone(),
            name: name.to_string(),
        });
        graph.graph_id = format!("{image}_{ver_id}");
        self.save_graph(image, &ver_id, &graph)?;
        self.save_manifest()?;
        Ok(ver_id)
    }

    /// Persists the command journal for a version. Called continuously by
    /// the application layer; on a clean save the journal is cleared.
    pub fn save_journal(
        &self,
        image: &str,
        version: &str,
        journal: &[JournalEntry],
    ) -> Result<(), ProjectError> {
        fs::create_dir_all(self.image_dir(image))?;
        atomic::write_json(
            self.journal_path(image, version),
            serde_json::to_string(journal)?,
        )?;
        Ok(())
    }

    pub fn load_journal(&self, image: &str, version: &str) -> Result<Vec<JournalEntry>, ProjectError> {
        let path = self.journal_path(image, version);
        if !path.exists() {
            return Ok(Vec::new());
        }
        Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
    }

    pub fn clear_journal(&self, image: &str, version: &str) -> Result<(), ProjectError> {
        let path = self.journal_path(image, version);
        if path.exists() {
            atomic::write_json(path, b"[]")?;
        }
        Ok(())
    }

    /// Crash recovery: rebuilds the graph by replaying the persisted journal
    /// from an empty graph.
    pub fn recover_graph(
        &self,
        image: &str,
        version: &str,
        registry: &Registry,
    ) -> Result<Graph, ProjectError> {
        let journal = self.load_journal(image, version)?;
        let graph_id = format!("{image}_{version}");
        let processor = CommandProcessor::replay(&graph_id, registry, &journal)?;
        Ok(processor.into_graph())
    }

    pub fn save_group(&self, group: &GroupDef) -> Result<PathBuf, ProjectError> {
        let safe: String = group
            .name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let path = self
            .root
            .join("groups")
            .join(format!("{safe}.{GROUP_EXTENSION}"));
        atomic::write_json(&path, serde_json::to_vec_pretty(group)?)?;
        Ok(path)
    }

    pub fn list_groups(&self) -> Result<Vec<GroupDef>, ProjectError> {
        let mut groups = Vec::new();
        for entry in fs::read_dir(self.root.join("groups"))? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) == Some(GROUP_EXTENSION) {
                groups.push(GroupDef::load(&path)?);
            }
        }
        groups.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(groups)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_commands::Command;
    use heeler_graph::group::GroupDef;
    use heeler_graph::{ParamValue, Section};

    fn setup() -> (tempfile::TempDir, Project, Registry) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Test.heelerproj");
        let project = Project::create(&root, "Test").unwrap();
        (dir, project, Registry::builtin())
    }

    #[test]
    fn clearing_a_journal_keeps_its_previous_bytes_without_a_removal() {
        let d = tempfile::tempdir().unwrap(); let p = Project::create(d.path(), "Journal").unwrap();
        let file = p.journal_path("image", "v1"); fs::create_dir_all(file.parent().unwrap()).unwrap();
        atomic::write_json(&file, b"[{\"event\":1}]").unwrap();
        p.clear_journal("image", "v1").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"[]");
        assert_eq!(fs::read(file.with_extension("json.good")).unwrap(), b"[{\"event\":1}]");
    }

    #[test]
    fn create_and_reopen_round_trips_manifest() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/photos/wedding/001.dng"), &registry).unwrap();
        let reopened = Project::open(project.root()).unwrap();
        assert_eq!(reopened.manifest, project.manifest);
        assert_eq!(reopened.image(&img).unwrap().active_version, "v1");
    }

    #[test]
    fn create_builds_expected_directory_layout() {
        let (_dir, project, _r) = setup();
        for sub in ["graphs/images", "graphs/collections", "groups", "cache"] {
            assert!(project.root().join(sub).is_dir(), "missing {sub}");
        }
        assert!(project.root().join(MANIFEST_FILE).is_file());
    }

    #[test]
    fn add_image_creates_default_two_node_graph() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/photos/001.dng"), &registry).unwrap();
        let graph = project.load_graph(&img, "v1").unwrap();
        assert_eq!(graph.node_count(), 2);
        assert_eq!(graph.connections().len(), 1);
        assert!(graph.node("src").is_some());
        assert!(graph.node("out").is_some());
        assert_eq!(graph.graph_id, format!("{img}_v1"));
    }

    #[test]
    fn image_under_project_root_gets_relative_path() {
        let (_dir, mut project, registry) = setup();
        let inside = project.root().join("captures").join("001.dng");
        let img = project.add_image(&inside, &registry).unwrap();
        assert_eq!(
            project.image(&img).unwrap().source_rel.as_deref(),
            Some("captures/001.dng")
        );
        let outside_img = project
            .add_image(Path::new("Q:/elsewhere/002.dng"), &registry)
            .unwrap();
        assert_eq!(project.image(&outside_img).unwrap().source_rel, None);
    }

    #[test]
    fn resolve_source_falls_back_to_relative_path() {
        let (_dir, mut project, registry) = setup();
        let captures = project.root().join("captures");
        fs::create_dir_all(&captures).unwrap();
        let file = captures.join("001.dng");
        fs::write(&file, b"fake raw").unwrap();

        let img = project.add_image(&file, &registry).unwrap();
        assert_eq!(project.resolve_source(&img).unwrap(), Some(file.clone()));

        // Simulate the project directory having moved: break the abs path.
        project.image_mut(&img).unwrap().source_abs = "Z:/gone/001.dng".into();
        assert_eq!(project.resolve_source(&img).unwrap(), Some(file));

        // Missing entirely.
        fs::remove_file(project.root().join("captures/001.dng")).unwrap();
        assert_eq!(project.resolve_source(&img).unwrap(), None);
    }

    #[test]
    fn graph_save_load_round_trip() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/p/001.dng"), &registry).unwrap();
        let mut graph = project.load_graph(&img, "v1").unwrap();
        graph
            .add_node(registry.instantiate("heeler.exposure", "e", Section::Creative).unwrap())
            .unwrap();
        project.save_graph(&img, "v1", &graph).unwrap();
        assert_eq!(project.load_graph(&img, "v1").unwrap(), graph);
    }

    #[test]
    fn missing_version_errors() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/p/001.dng"), &registry).unwrap();
        assert!(matches!(
            project.load_graph(&img, "v9"),
            Err(ProjectError::VersionNotFound { .. })
        ));
    }

    #[test]
    fn versions_branch_independently() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/p/001.dng"), &registry).unwrap();
        let v2 = project.add_version(&img, "Black and White", "v1").unwrap();
        assert_eq!(v2, "v2");

        let mut bw = project.load_graph(&img, &v2).unwrap();
        bw.add_node(registry.instantiate("heeler.levels", "l", Section::Creative).unwrap())
            .unwrap();
        project.save_graph(&img, &v2, &bw).unwrap();

        let original = project.load_graph(&img, "v1").unwrap();
        assert_eq!(original.node_count(), 2, "v1 untouched by v2 edits");
        assert_eq!(project.load_graph(&img, &v2).unwrap().node_count(), 3);
        assert_eq!(project.image(&img).unwrap().versions.len(), 2);
    }

    #[test]
    fn journal_recovery_rebuilds_graph_after_crash() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/p/001.dng"), &registry).unwrap();

        // Simulate an editing session that journals but never cleanly saves.
        let graph_id = format!("{img}_v1");
        let mut proc = CommandProcessor::new(Graph::new(&graph_id), &registry);
        proc.apply(Command::CreateNode {
            node_type: "heeler.image_source".into(),
            node_id: "src".into(),
            section: Section::RawFoundation,
        })
        .unwrap();
        proc.apply(Command::CreateNode {
            node_type: "heeler.exposure".into(),
            node_id: "e".into(),
            section: Section::Creative,
        })
        .unwrap();
        proc.apply(Command::Connect {
            from_node: "src".into(),
            from_port: "out".into(),
            to_node: "e".into(),
            to_port: "in".into(),
        })
        .unwrap();
        proc.apply(Command::SetParam {
            node_id: "e".into(),
            param: "exposure".into(),
            value: ParamValue::Number(0.7),
        })
        .unwrap();
        proc.undo().unwrap();
        project.save_journal(&img, "v1", proc.journal()).unwrap();

        let recovered = project.recover_graph(&img, "v1", &registry).unwrap();
        assert_eq!(&recovered, proc.graph());
        assert_eq!(
            recovered.node("e").unwrap().params.get("exposure"),
            Some(&ParamValue::Number(0.0)),
            "the undone param change must stay undone after recovery"
        );

        project.clear_journal(&img, "v1").unwrap();
        assert!(project.load_journal(&img, "v1").unwrap().is_empty());
    }

    #[test]
    fn groups_save_and_list() {
        let (_dir, mut project, registry) = setup();
        let img = project.add_image(Path::new("D:/p/001.dng"), &registry).unwrap();
        let mut graph = project.load_graph(&img, "v1").unwrap();
        graph
            .add_node(registry.instantiate("heeler.exposure", "e", Section::Creative).unwrap())
            .unwrap();

        let mut def = GroupDef::extract(&graph, "Cinematic Portrait Grade", &["e"]).unwrap();
        def.tags = vec!["portrait".into()];
        let path = project.save_group(&def).unwrap();
        assert!(path.file_name().unwrap().to_string_lossy().ends_with(".heelergroup"));

        let listed = project.list_groups().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], def);
    }
}
