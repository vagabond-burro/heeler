"""Render the EXR render-pass fixture with a locally installed 3D renderer.

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/render_exr_fixture.py -- OUT.exr [WIDTH]

Writes one single-part multilayer OpenEXR (32-bit float, ZIP) holding
Combined RGBA, Depth.Z, Mist.Z, Normal.XYZ, CryptoObject and
CryptoMaterial from a small path-traced scene: a ground plane, a red sphere,
a green cube, Suzanne in blue, a far metallic pillar and a yellow cone,
lit by a sun and a blue sky. Six named objects and six materials, so
the Cryptomatte manifests are worth reading. WIDTH defaults to 960; the
height follows at 3:2. The scene is built from the factory startup, so
no .blend file is needed and the result is ours outright.

Written 2026-09-14 to produce the render-pass fixtures.
"""
import bpy, math, sys
args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
width = int(args[1]) if len(args) > 1 else 960
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 32
sc.cycles.use_denoising = False
sc.render.resolution_x, sc.render.resolution_y = width, width * 2 // 3
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'OPEN_EXR_MULTILAYER'
sc.render.image_settings.color_depth = '32'
sc.render.image_settings.exr_codec = 'ZIP'
sc.render.filepath = out
# world light
w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True
bg = w.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.35, 0.45, 0.7, 1); bg.inputs[1].default_value = 1.0
def mat(name, rgb, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
    return m
def add(op, name, loc, m, **kw):
    op(location=loc, **kw); o = bpy.context.active_object; o.name = name; o.data.materials.append(m); return o
add(bpy.ops.mesh.primitive_plane_add, "Ground", (0,0,0), mat("Ground", (0.5,0.45,0.4), 0.8), size=40)
add(bpy.ops.mesh.primitive_uv_sphere_add, "SphereRed", (-2.2,0,1), mat("Red", (0.8,0.1,0.1), 0.3), radius=1)
bpy.ops.object.shade_smooth()
add(bpy.ops.mesh.primitive_cube_add, "CubeGreen", (0.6,1.5,0.9), mat("Green", (0.1,0.6,0.15), 0.6), size=1.8)
add(bpy.ops.mesh.primitive_monkey_add, "Suzanne", (2.6,-0.5,1.1), mat("Blue", (0.15,0.25,0.85), 0.4), size=1.6)
bpy.ops.object.shade_smooth()
add(bpy.ops.mesh.primitive_cylinder_add, "PillarFar", (1.5,8,2), mat("Gray", (0.6,0.6,0.6), 0.5, 0.8), radius=0.8, depth=4)
add(bpy.ops.mesh.primitive_cone_add, "ConeYellow", (-4,5,1.5), mat("Yellow", (0.9,0.75,0.1), 0.5), radius1=1.2, depth=3)
# sun
bpy.ops.object.light_add(type='SUN', location=(4,-4,8)); sun = bpy.context.active_object
sun.data.energy = 4.0; sun.rotation_euler = (math.radians(45), math.radians(20), math.radians(40))
# camera
bpy.ops.object.camera_add(location=(0,-9,3.2), rotation=(math.radians(78),0,0)); cam = bpy.context.active_object
sc.camera = cam; cam.data.lens = 40
# passes
vl = sc.view_layers[0]
vl.use_pass_z = True; vl.use_pass_normal = True; vl.use_pass_combined = True
vl.use_pass_cryptomatte_object = True; vl.use_pass_cryptomatte_material = True; vl.pass_cryptomatte_depth = 6
vl.use_pass_mist = True
sc.view_settings.view_transform = 'Standard'
bpy.ops.render.render(write_still=True)
print("RENDERED", out)
