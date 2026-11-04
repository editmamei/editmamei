# Tools

**112 tools total.** The Photoshop surface is **83 tools across 16 capability groups** (62 Community, 21 Pro), covering the work in groups rather than one tool per Photoshop feature. Every one is namespaced `ps_*` and discoverable at runtime via `tools/list`. Community tools ship in both editions; Pro tools unlock with a license. Alongside it, a second, independent editor surface drives headless GIMP: **29 `gimp_*` tools, Community**, see [GIMP](#gimp) below. Pro's additions are Photoshop-only; GIMP has no Pro tier.

The [pro-features page](pro-features.md) explains what each edition includes.

## Photoshop

| Group | Edition | Tools |
| --- | --- | --- |
| **Core** | Community | `ping` · `overview` · `list_capabilities` · `undo` · `redo` · `report_problem` |
| **Inspect** | Community | `inspect` · `get_preview` |
| **Verify** | Community | `get_histogram` · `compare_regions` · `get_layer_bounds_diff` · `get_selection_preview` |
| **Document & canvas** | Community | `document` · `create_document` · `open_document` · `close_document` · `save_psd` · `export` · `place_image` · `resize_image` · `crop_document` · `convert_image_mode` · `transform_canvas` · `guides` |
| **Selection** | Community | `select` · `modify_selection` · `selection_channel` |
| **Adjustments** | Community | `add_adjustment_layer` · `apply_adjustment` |
| **Filters** | Community | `filter` |
| **Retouch** | Community | `retouch` |
| **Layers** | Community | `create_layer` · `delete_layer` · `fill_layer` · `add_fill_layer` · `select_layer` · `move_layer_to_position` · `duplicate_layer` · `copy_to_new_layer` · `convert_to_smart_object` · `rasterize_layer` · `set_layer` · `merge` · `bake_layer` · `add_layer_style` · `transform_layer` · `shape` · `group` |
| **Masks & paths** | Community | `layer_mask` · `clipping_mask` · `path` · `vector_mask` · `apply_image` · `calculations` |
| **Type** | Community | `text` |
| **Perception** | Community | `detect` · `read_scene` · `select_by_reference` |
| **AI selection** | Community | `select_subject` · `select_sky` · `replace_sky` |
| **Automation** | Community | `sequence` |
| **AI selection** | Pro | `select_subject_instance` · `select_object` |
| **Filters** | Pro | `apply_camera_raw` · `develop_raw` |
| **Layers (warp)** | Pro | `warp_layer` |
| **Perception** | Pro | `edit_object` · `add_text_to_object` · `resolve_placement` |
| **Face mesh** | Pro | `detect_landmarks` · `select_face_feature` |
| **Templates** | Pro | `template_create_evidence` · `template_save` · `template_list` · `template_apply` · `template_verify` · `template_recall` · `template_delete` |
| **Automation** | Pro | `list_actions` · `play_action` · `execute_script` · `batch` |

## GIMP

A separate namespace, all Community.

| Group | Edition | Tools |
| --- | --- | --- |
| **GIMP** | Community | `gimp_ping` · `gimp_overview` · `gimp_open_document` · `gimp_close_document` · `gimp_save_xcf` · `gimp_export` · `gimp_inspect` · `gimp_add_adjustment` · `gimp_add_effect` · `gimp_filter` · `gimp_bake` · `gimp_layer` · `gimp_transform_layer` · `gimp_text` · `gimp_select` · `gimp_modify_selection` · `gimp_layer_mask` · `gimp_get_selection_preview` · `gimp_create_document` · `gimp_place_image` · `gimp_canvas` · `gimp_convert_image_mode` · `gimp_crop_document` · `gimp_resize_image` · `gimp_transform_canvas` · `gimp_checkpoint` · `gimp_get_preview` · `gimp_get_histogram` · `gimp_compare` |

It covers documents (open, create, save `.xcf`, export), layers and groups, placing one photo into another, 13 non-destructive adjustment types and nine effects (vignette, black and white, motion and lens blur, noise, drop shadow, outline, outer glow, surface blur), selections (shapes, color range, magic wand, gradients) you can attach as layer masks, live text layers, moving, scaling and rotating layers, crop/resize/rotate/flip, canvas extension, color/grayscale conversion, checkpoints you can restore, and the same preview/histogram/compare verification primitives the Photoshop side has. It doesn't yet cover heal/clone or AI subject and sky selection. Full details, requirements, and troubleshooting: [gimp.md](gimp.md).
