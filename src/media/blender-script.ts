// Executed only by the bounded media worker in a separate Blender process.
// The source .blend is never saved; automatic embedded Python execution is disabled.
export const BLENDER_REVIEW_SCRIPT = String.raw`
import bpy, bmesh, sys, json, os, math
from mathutils import Vector

request = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8'))
source = request['path']
output = request['outputDirectory']
ext = os.path.splitext(source)[1].lower()
bpy.context.preferences.filepaths.use_scripts_auto_execute = False

# Disallow glTF resource fetches outside the local asset directory. This does
# not make Blender a sandbox; untrusted assets need an OS/container boundary.
def check_gltf_resources():
    if ext == '.gltf':
        if os.path.getsize(source) > 64 * 1024 * 1024:
            raise RuntimeError('glTF JSON exceeds 64 MiB')
        doc = json.load(open(source, encoding='utf-8'))
    elif ext == '.glb':
        import struct
        with open(source, 'rb') as f:
            header = f.read(20)
            if len(header) != 20 or header[:4] != b'glTF':
                raise RuntimeError('Invalid GLB header')
            size, kind = struct.unpack('<II', header[12:20])
            if kind != 0x4E4F534A or size > 64 * 1024 * 1024:
                raise RuntimeError('Invalid or oversized GLB JSON chunk')
            doc = json.loads(f.read(size))
    else:
        return
    from urllib.parse import unquote, urlsplit
    base = os.path.realpath(os.path.dirname(source))
    for item in doc.get('buffers', []) + doc.get('images', []):
        uri = item.get('uri', '')
        if not uri or uri.startswith('data:'):
            continue
        parsed = urlsplit(uri)
        decoded = unquote(uri)
        if parsed.scheme or parsed.netloc or decoded.startswith(('\\\\', '//')) or ':' in decoded:
            raise RuntimeError('Only local relative glTF resources are accepted')
        target = os.path.realpath(os.path.join(base, decoded))
        if os.path.commonpath([base, target]) != base:
            raise RuntimeError('glTF resource escapes its asset directory')
        if not os.path.isfile(target):
            raise RuntimeError('Missing glTF resource: ' + decoded)

check_gltf_resources()
if ext == '.blend':
    bpy.ops.wm.open_mainfile(filepath=source, load_ui=False, use_scripts=False)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=source)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=source)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=source)
    else:
        raise RuntimeError('Unsupported asset extension')

scene = bpy.context.scene
if request.get('animationFrame') is not None:
    scene.frame_set(request['animationFrame'])
selected = list(scene.objects)
if request.get('objectName'):
    root = scene.objects.get(request['objectName'])
    if root is None:
        raise RuntimeError('Requested objectName not found')
    selected = [root] + list(root.children_recursive)
meshes = [o for o in selected if o.type == 'MESH']
if not meshes:
    raise RuntimeError('No mesh objects in selected scene or object hierarchy')
if len(meshes) > 500 or sum(len(o.data.vertices) for o in meshes) > 5000000:
    raise RuntimeError('Asset exceeds review budget: 500 mesh objects / 5 million base vertices')

rows = []
for obj in meshes:
    m = obj.data
    row = dict(name=obj.name, vertices=len(m.vertices), edges=len(m.edges),
               polygons=len(m.polygons), triangles=sum(max(0,len(p.vertices)-2) for p in m.polygons),
               uvLayers=len(m.uv_layers), materialSlots=len(obj.material_slots),
               negativeScale=any(x < 0 for x in obj.scale), scale=list(obj.scale),
               vertexGroups=len(obj.vertex_groups),
               shapeKeys=len(m.shape_keys.key_blocks) if m.shape_keys else 0,
               modifiers=[x.type for x in obj.modifiers],
               armatureBound=any(x.type == 'ARMATURE' for x in obj.modifiers))
    if len(m.polygons) <= 250000:
        bm = bmesh.new()
        try:
            bm.from_mesh(m)
            row['nonManifoldEdges'] = sum(not e.is_manifold for e in bm.edges)
            row['boundaryEdges'] = sum(e.is_boundary for e in bm.edges)
            row['looseVertices'] = sum(not v.link_edges for v in bm.verts)
            row['zeroAreaFaces'] = sum(f.calc_area() < 1e-12 for f in bm.faces)
        finally:
            bm.free()
    else:
        row['topologyDetails'] = 'SKIPPED_BUDGET'
    rows.append(row)

missing = []
for im in bpy.data.images:
    if im.source in ('GENERATED','VIEWER') or im.packed_file or not im.filepath:
        continue
    filename = bpy.path.abspath(im.filepath, library=im.library)
    if not os.path.isfile(filename):
        missing.append(dict(name=im.name, path=filename))
report = dict(version=1, blenderVersion=bpy.app.version_string, sourceSaved=False,
              autoExecute=False, acceptance='NOT_REVIEWED',
              topologyScope='BASE_MESH_NOT_EVALUATED_MODIFIERS',
              totals=dict(meshes=len(rows), vertices=sum(x['vertices'] for x in rows),
                          triangles=sum(x['triangles'] for x in rows)),
              meshes=rows, missingTextures=missing[:200],
              missingTextureCount=len(missing),
              armatures=[dict(name=o.name,bones=len(o.data.bones)) for o in selected if o.type == 'ARMATURE'],
              actions=[a.name for a in bpy.data.actions][:200],
              sceneFrame=scene.frame_current, frameRange=[scene.frame_start,scene.frame_end],
              note='Open boundaries and negative scale are review candidates, not automatic rejection. No Khronos glTF conformance validation is claimed.')

if request.get('preview'):
    # A CPU-only, neutral clay proxy is deliberately distinct from a material
    # beauty render. It cannot establish texture quality or reference likeness.
    for o in scene.objects:
        o.hide_render = o not in selected or o.type not in ('MESH','ARMATURE')
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    lo = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = (lo + hi) / 2
    extent = max((hi-lo).length, 0.1)
    if not math.isfinite(extent):
        raise RuntimeError('Non-finite asset bounds')
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 8
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 2
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 2
    scene.render.resolution_x = int(request.get('resolution',512))
    scene.render.resolution_y = int(request.get('resolution',512))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.use_nodes = False
    world = bpy.data.worlds.new('MEDIA_REVIEW_WORLD')
    world.use_nodes = True
    world.node_tree.nodes.get('Background').inputs['Color'].default_value = (0.06,0.07,0.09,1)
    world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.5
    scene.world = world
    material = bpy.data.materials.new('MEDIA_REVIEW_CLAY')
    material.diffuse_color = (0.6,0.6,0.6,1)
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (0.6,0.6,0.6,1)
    shader.inputs['Roughness'].default_value = 0.65
    for layer in scene.view_layers:
        layer.material_override = material
    for i, direction in enumerate([(1,-2,2),(-2,-1,1),(0,2,2)]):
        light = bpy.data.lights.new('MEDIA_REVIEW_LIGHT_'+str(i),'AREA')
        light.energy = 100 * extent * extent
        light.shape = 'DISK'
        light.size = extent * 1.5
        obj = bpy.data.objects.new(light.name,light)
        scene.collection.objects.link(obj)
        obj.location = center + Vector(direction) * extent
        obj.rotation_euler = (center-obj.location).to_track_quat('-Z','Y').to_euler()
    camera = bpy.data.cameras.new('MEDIA_REVIEW_CAMERA')
    cam = bpy.data.objects.new(camera.name,camera)
    scene.collection.objects.link(cam)
    scene.camera = cam
    camera.type = 'ORTHO'
    camera.ortho_scale = extent * 1.12
    camera.clip_start = max(0.001,extent/10000)
    camera.clip_end = extent * 100
    views = [('front',(0,-3,0)),('right',(3,0,0)),('back',(0,3,0)),('three-quarter',(2,-3,1.5))]
    for label, direction in views:
        cam.location = center + Vector(direction) * extent
        cam.rotation_euler = (center-cam.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath = os.path.join(output,'view-'+label+'.png')
        bpy.ops.render.render(write_still=True)
    report['preview'] = dict(mode='CPU_CLAY_GEOMETRY', views=[x[0] for x in views],
                             samples=8, originalMaterialsEvaluated=False, bounds=[list(lo),list(hi)])

with open(os.path.join(output,'asset-audit.json'),'w',encoding='utf-8') as f:
    json.dump(report,f,ensure_ascii=False,indent=2,allow_nan=False)
print('MEDIA_ASSET_REVIEW_COMPLETE')
`;
