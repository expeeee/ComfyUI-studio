from __future__ import annotations

import copy
from typing import Any

from app.templates.inspector import UI_ONLY_NODES

WIDGET_PRIMITIVE_TYPES = {
    "INT",
    "FLOAT",
    "STRING",
    "BOOLEAN",
    "COMBO",
    "COMFY_DYNAMICCOMBO_V3",
    "LOAD_3D",
}
CONTROL_AFTER_GENERATE_VALUES = {"fixed", "increment", "decrement", "randomize"}


def _normalize_links(raw_links: list[Any]) -> dict[int, dict[str, Any]]:
    """Normalize LiteGraph links list (either list-of-lists or list-of-dicts) into {link_id: dict}."""
    links: dict[int, dict[str, Any]] = {}
    for item in raw_links or []:
        if isinstance(item, list) and len(item) >= 5:
            lid = int(item[0])
            links[lid] = {
                "id": lid,
                "origin_id": item[1],
                "origin_slot": int(item[2]),
                "target_id": item[3],
                "target_slot": int(item[4]),
                "type": item[5] if len(item) > 5 else "*",
            }
        elif isinstance(item, dict) and "id" in item:
            lid = int(item["id"])
            links[lid] = {
                "id": lid,
                "origin_id": item["origin_id"],
                "origin_slot": int(item["origin_slot"]),
                "target_id": item["target_id"],
                "target_slot": int(item["target_slot"]),
                "type": item.get("type", "*"),
            }
    return links


def is_widget_input_spec(spec: Any) -> bool:
    """Return True if an /object_info input spec represents a widget (rather than a pure node link)."""
    if not isinstance(spec, list) or len(spec) == 0:
        return False
    first = spec[0]
    if isinstance(first, list):
        # COMBO options list
        return True
    if isinstance(first, str):
        if first in WIDGET_PRIMITIVE_TYPES:
            return True
    return False


def get_ordered_widget_specs(
    node_schema_or_input_block: dict[str, Any],
) -> list[tuple[str, Any, bool, bool]]:
    """
    Return ordered list of (input_name, spec, has_control_after_generate, is_required)
    for a node class_type from /object_info (or a nested COMFY_DYNAMICCOMBO_V3 input block).
    """
    if "input" in node_schema_or_input_block and isinstance(node_schema_or_input_block["input"], dict):
        input_block = node_schema_or_input_block["input"]
    else:
        input_block = node_schema_or_input_block

    ordered: list[tuple[str, Any, bool, bool]] = []
    for section in ("required", "optional"):
        is_req = section == "required"
        sec_dict = input_block.get(section) or {}
        for inp_name, spec in sec_dict.items():
            if is_widget_input_spec(spec):
                opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
                has_cag = bool(opts.get("control_after_generate")) or inp_name in (
                    "seed",
                    "noise_seed",
                )
                ordered.append((inp_name, spec, has_cag, is_req))
    return ordered


def _default_for_spec(spec: Any) -> tuple[bool, Any]:
    """Return (has_default, default_value) for a widget input spec when widgets_values omits it."""
    if not isinstance(spec, list) or len(spec) == 0:
        return (False, None)
    first = spec[0]
    opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if "default" in opts:
        return (True, opts["default"])
    if isinstance(first, list) and len(first) > 0:
        return (True, first[0])
    if first == "COMBO":
        combo_opts = opts.get("options")
        if isinstance(combo_opts, list) and len(combo_opts) > 0:
            return (True, combo_opts[0])
    if first == "COMFY_DYNAMICCOMBO_V3":
        dyn_opts = opts.get("options")
        if isinstance(dyn_opts, list) and len(dyn_opts) > 0 and isinstance(dyn_opts[0], dict):
            return (True, dyn_opts[0].get("key"))
    if first == "LOAD_3D":
        return (True, "")
    return (False, None)


def map_node_widgets(
    node: dict[str, Any],
    node_schema: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Extract {input_name: value} from a node's widgets_values using /object_info schema.
    Supports V3 COMFY_DYNAMICCOMBO_V3 nested inputs (e.g. SaveVideo 'format' and 'format.codec'),
    dict-style widgets_values, and control_after_generate pseudo-widgets.
    """
    raw_wv = node.get("widgets_values")
    if isinstance(raw_wv, dict):
        return {k: v for k, v in raw_wv.items() if not k.startswith("__")}
    if not isinstance(raw_wv, list):
        raw_wv = []

    if not node_schema:
        # Fallback: map widget inputs declared on the node itself
        widget_inputs = [
            inp["name"]
            for inp in (node.get("inputs") or [])
            if isinstance(inp, dict) and inp.get("widget") and inp.get("name")
        ]
        result: dict[str, Any] = {}
        idx = 0
        for wname in widget_inputs:
            if idx >= len(raw_wv):
                break
            result[wname] = raw_wv[idx]
            idx += 1
            if (
                wname in ("seed", "noise_seed")
                and idx < len(raw_wv)
                and isinstance(raw_wv[idx], str)
                and raw_wv[idx] in CONTROL_AFTER_GENERATE_VALUES
            ):
                idx += 1
        return result

    result = {}
    idx = 0

    def _consume_block(schema_or_block: dict[str, Any], prefix: str = "") -> None:
        nonlocal idx
        ordered_specs = get_ordered_widget_specs(schema_or_block)
        for slot_pos, (inp_name, spec, has_cag, is_req) in enumerate(ordered_specs):
            full_key = f"{prefix}.{inp_name}" if prefix else inp_name
            opts = (
                spec[1]
                if isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict)
                else {}
            )
            # Hidden optional inputs (like SaveVideo's legacy top-level 'codec') do not have a
            # separate widget when already consumed by a dynamic combo
            if not is_req and prefix == "" and inp_name == "codec" and f"format.{inp_name}" in result:
                continue

            if idx < len(raw_wv):
                val = raw_wv[idx]
                idx += 1
                remaining_specs = len(ordered_specs) - (slot_pos + 1)
                if has_cag and idx < len(raw_wv):
                    next_val = raw_wv[idx]
                    if isinstance(next_val, str) and next_val in CONTROL_AFTER_GENERATE_VALUES:
                        idx += 1
                    elif len(raw_wv) - idx >= (remaining_specs + 1) and isinstance(next_val, str):
                        idx += 1
                if opts.get("image_upload") and idx < len(raw_wv) and raw_wv[idx] in ("image", "upload"):
                    idx += 1
            elif is_req:
                has_def, def_val = _default_for_spec(spec)
                if not has_def:
                    continue
                val = def_val
            else:
                continue

            result[full_key] = val

            # If this is a COMFY_DYNAMICCOMBO_V3, recursively consume its selected option's nested inputs
            if isinstance(spec, list) and len(spec) > 0 and spec[0] == "COMFY_DYNAMICCOMBO_V3":
                dyn_options = opts.get("options") or []
                selected_opt = next(
                    (o for o in dyn_options if isinstance(o, dict) and o.get("key") == val),
                    dyn_options[0] if dyn_options and isinstance(dyn_options[0], dict) else None,
                )
                if selected_opt and isinstance(selected_opt.get("inputs"), dict):
                    _consume_block(selected_opt["inputs"], prefix=full_key)

    _consume_block(node_schema, prefix="")
    return result


class FlattenContext:
    """Holds flattened execution nodes, resolved links, and subgraph proxy metadata."""

    def __init__(self, object_info: dict[str, Any]) -> None:
        self.object_info = object_info
        self.nodes: dict[str, dict[str, Any]] = {}
        # (target_node_id, input_name) -> (source_node_id, source_slot_idx)
        self.input_links: dict[tuple[str, str], tuple[str, int]] = {}
        # (target_node_id, input_name) -> overridden widget value from outer subgraph
        self.widget_overrides: dict[tuple[str, str], Any] = {}
        # Ordered list of proxy/exposed controls: (node_id, input_name, label)
        self.exposed_controls: list[tuple[str, str, str | None]] = []


def flatten_workflow(
    workflow: dict[str, Any],
    object_info: dict[str, Any] | None = None,
) -> FlattenContext:
    """
    Flatten a workflow JSON (expanding any definitions.subgraphs recursively) into
    concrete execution nodes, resolved links, and widget overrides.
    """
    obj_info = object_info or {}
    ctx = FlattenContext(obj_info)
    subgraphs_by_id: dict[str, dict[str, Any]] = {
        sg["id"]: sg
        for sg in (workflow.get("definitions", {}).get("subgraphs") or [])
        if isinstance(sg, dict) and "id" in sg
    }

    def _expand_scope(
        scope_nodes: list[dict[str, Any]],
        scope_links: dict[int, dict[str, Any]],
        prefix: str = "",
        outer_input_wires: dict[int, tuple[str, int]] | None = None,
        outer_input_values: dict[int, Any] | None = None,
    ) -> dict[tuple[Any, int], tuple[str, int]]:
        """
        Expand a graph scope (top-level or subgraph) and return a mapping of
        (local_node_id, output_slot) -> (resolved_global_node_id, resolved_output_slot).
        """
        outer_wires = outer_input_wires or {}
        outer_vals = outer_input_values or {}
        nodes_by_local_id: dict[Any, dict[str, Any]] = {n["id"]: n for n in scope_nodes if "id" in n}

        def _trace_origin(link_id: int, visited: set[int] | None = None) -> tuple[Any, int] | None:
            vis = visited or set()
            if link_id in vis:
                return None
            vis.add(link_id)
            linfo = scope_links.get(link_id)
            if not linfo:
                return None
            orig_id = linfo["origin_id"]
            orig_slot = int(linfo["origin_slot"])
            if orig_id == -10:
                return (-10, orig_slot)
            orig_node = nodes_by_local_id.get(orig_id)
            if not orig_node:
                return None
            ntype = orig_node.get("type")
            if ntype in ("Reroute", "NodeReroute") or orig_node.get("mode") == 4:
                inps = orig_node.get("inputs") or []
                chosen_link = None
                if orig_slot < len(inps) and inps[orig_slot].get("link") is not None:
                    chosen_link = int(inps[orig_slot]["link"])
                else:
                    for inp in inps:
                        if inp.get("link") is not None:
                            chosen_link = int(inp["link"])
                            break
                if chosen_link is not None:
                    return _trace_origin(chosen_link, vis)
                return None
            return (orig_id, orig_slot)

        subgraph_output_map: dict[tuple[Any, int], tuple[str, int]] = {}
        for local_id, node in nodes_by_local_id.items():
            if node.get("mode") in (2, 4):
                continue
            ntype = node.get("type")
            if ntype in subgraphs_by_id:
                sg_def = subgraphs_by_id[ntype]
                sg_prefix = f"{prefix}{local_id}:"
                sg_links = _normalize_links(sg_def.get("links") or [])
                sg_inputs = sg_def.get("inputs") or []
                node_inputs_by_name = {
                    inp.get("name"): inp for inp in (node.get("inputs") or []) if isinstance(inp, dict)
                }

                child_wires: dict[int, tuple[str, int]] = {}
                child_vals: dict[int, Any] = {}
                outer_wv = node.get("widgets_values") if isinstance(node.get("widgets_values"), list) else []
                wv_cursor = 0

                for slot_idx, sg_inp in enumerate(sg_inputs):
                    inp_name = sg_inp.get("name")
                    outer_inp = node_inputs_by_name.get(inp_name)
                    outer_link_id = outer_inp.get("link") if outer_inp else None
                    if outer_link_id is not None:
                        traced = _trace_origin(int(outer_link_id))
                        if traced is not None:
                            if traced[0] == -10:
                                if traced[1] in outer_wires:
                                    child_wires[slot_idx] = outer_wires[traced[1]]
                            elif traced in subgraph_output_map:
                                child_wires[slot_idx] = subgraph_output_map[traced]
                            else:
                                child_wires[slot_idx] = (f"{prefix}{traced[0]}", traced[1])

                    sg_inp_type = sg_inp.get("type", "")
                    is_media_port = sg_inp_type in (
                        "IMAGE",
                        "LATENT",
                        "MODEL",
                        "CLIP",
                        "VAE",
                        "CONDITIONING",
                        "MASK",
                        "AUDIO",
                        "VIDEO",
                    )
                    if not is_media_port and wv_cursor < len(outer_wv):
                        child_vals[slot_idx] = outer_wv[wv_cursor]
                        wv_cursor += 1

                proxy_widgets = (node.get("properties") or {}).get("proxyWidgets") or []
                for pw in proxy_widgets:
                    if isinstance(pw, list) and len(pw) >= 2 and pw[1] != "control_after_generate":
                        ctx.exposed_controls.append((f"{sg_prefix}{pw[0]}", str(pw[1]), None))

                for slot_idx, sg_inp in enumerate(sg_inputs):
                    for lid in sg_inp.get("linkIds") or []:
                        linfo = sg_links.get(int(lid))
                        if not linfo:
                            continue
                        target_local_id = linfo["target_id"]
                        target_slot = int(linfo["target_slot"])
                        target_node = next(
                            (n for n in (sg_def.get("nodes") or []) if n.get("id") == target_local_id),
                            None,
                        )
                        if target_node and target_slot < len(target_node.get("inputs") or []):
                            t_inp_name = target_node["inputs"][target_slot].get("name")
                            if t_inp_name:
                                label = sg_inp.get("label") or sg_inp.get("name")
                                ctx.exposed_controls.append(
                                    (f"{sg_prefix}{target_local_id}", str(t_inp_name), label)
                                )

                child_outputs = _expand_scope(
                    sg_def.get("nodes") or [],
                    sg_links,
                    prefix=sg_prefix,
                    outer_input_wires=child_wires,
                    outer_input_values=child_vals,
                )
                for out_slot_idx, sg_out in enumerate(sg_def.get("outputs") or []):
                    for lid in sg_out.get("linkIds") or []:
                        linfo = sg_links.get(int(lid))
                        if linfo and linfo.get("target_id") == -20:
                            orig_pair = (linfo["origin_id"], int(linfo["origin_slot"]))
                            if orig_pair in child_outputs:
                                subgraph_output_map[(local_id, out_slot_idx)] = child_outputs[orig_pair]

        resolved_outputs: dict[tuple[Any, int], tuple[str, int]] = dict(subgraph_output_map)
        for local_id, node in nodes_by_local_id.items():
            if node.get("mode") in (2, 4):
                continue
            ntype = node.get("type")
            if not ntype or ntype in UI_ONLY_NODES or ntype in subgraphs_by_id:
                continue
            global_id = f"{prefix}{local_id}"
            ctx.nodes[global_id] = copy.deepcopy(node)
            for out_idx in range(len(node.get("outputs") or [])):
                resolved_outputs[(local_id, out_idx)] = (global_id, out_idx)

        for local_id, node in nodes_by_local_id.items():
            if node.get("mode") in (2, 4):
                continue
            ntype = node.get("type")
            if not ntype or ntype in UI_ONLY_NODES or ntype in subgraphs_by_id:
                continue
            global_id = f"{prefix}{local_id}"
            for inp_idx, inp in enumerate(node.get("inputs") or []):
                inp_name = inp.get("name")
                link_id = inp.get("link")
                if not inp_name or link_id is None:
                    continue
                traced = _trace_origin(int(link_id))
                if traced is None:
                    continue
                orig_id, orig_slot = traced
                if orig_id == -10:
                    if orig_slot in outer_wires:
                        ctx.input_links[(global_id, inp_name)] = outer_wires[orig_slot]
                    elif orig_slot in outer_vals:
                        ctx.widget_overrides[(global_id, inp_name)] = outer_vals[orig_slot]
                elif orig_id in nodes_by_local_id and nodes_by_local_id[orig_id].get("type") == "PrimitiveNode":
                    prim_wv = nodes_by_local_id[orig_id].get("widgets_values") or []
                    if prim_wv:
                        ctx.widget_overrides[(global_id, inp_name)] = prim_wv[0]
                elif (orig_id, orig_slot) in resolved_outputs:
                    ctx.input_links[(global_id, inp_name)] = resolved_outputs[(orig_id, orig_slot)]
                else:
                    ctx.input_links[(global_id, inp_name)] = (f"{prefix}{orig_id}", orig_slot)

        return resolved_outputs

    top_links = _normalize_links(workflow.get("links") or [])
    _expand_scope(workflow.get("nodes") or [], top_links, prefix="")
    return ctx


def compile_workflow_to_api_prompt(
    workflow: dict[str, Any],
    object_info: dict[str, Any] | None = None,
    field_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Compile an editor workflow JSON (with optional subgraph definitions and user field overrides)
    into an executable ComfyUI /prompt dictionary.
    """
    obj_info = object_info or {}
    ctx = flatten_workflow(workflow, obj_info)
    overrides = field_overrides or {}

    api_prompt: dict[str, Any] = {}
    for node_id, node in ctx.nodes.items():
        class_type = str(node["type"])
        schema = obj_info.get(class_type)
        inputs_dict: dict[str, Any] = {}

        # 1. Populate widget values from the node's own widgets_values
        widget_vals = map_node_widgets(node, schema)
        inputs_dict.update(widget_vals)

        # 2. Apply outer subgraph widget_overrides (when subgraph node provided widgets_values)
        for (target_nid, inp_name), val in ctx.widget_overrides.items():
            if target_nid == node_id:
                inputs_dict[inp_name] = val

        # 3. Apply connected node links (links take precedence over widget defaults)
        for (target_nid, inp_name), (src_nid, src_slot) in ctx.input_links.items():
            if target_nid == node_id:
                inputs_dict[inp_name] = [str(src_nid), int(src_slot)]

        # 4. Apply user field overrides (only for non-linked inputs)
        for ov_key, ov_val in overrides.items():
            if "." in ov_key:
                ov_nid, ov_inp = ov_key.split(".", 1)
                if ov_nid == node_id and (node_id, ov_inp) not in ctx.input_links:
                    inputs_dict[ov_inp] = ov_val

        meta_title = node.get("title") or (schema or {}).get("display_name") or class_type
        api_prompt[node_id] = {
            "inputs": inputs_dict,
            "class_type": class_type,
            "_meta": {"title": meta_title},
        }

    return api_prompt
