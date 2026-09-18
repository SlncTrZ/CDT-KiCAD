/**
 * Discovery audit for the 60 tools that were registered but absent from the
 * keyword registry at the D12 baseline (236 registered / 176 indexed).
 *
 * This is an acceptance artifact, not a second registry. "should-index" entries
 * must become discoverable through src/tools/registry.ts. Entries intentionally
 * left out need a concrete reason here so a future omission cannot hide inside
 * a frozen numeric allowance.
 */

export type DiscoveryDisposition =
  | "should-index"
  | "intentional-direct-only"
  | "obsolete-duplicate";

export interface DiscoveryAuditEntry {
  disposition: DiscoveryDisposition;
  category?: string;
  rationale: string;
}

export const BASELINE_UNINDEXED_AUDIT: Readonly<Record<string, DiscoveryAuditEntry>> = {
  save_as: {
    disposition: "should-index",
    rationale: "Project lifecycle mutation is a supported public tool and should be discoverable.",
  },
  import_svg_logo: {
    disposition: "should-index",
    category: "board",
    rationale: "Board artwork import is a supported board operation.",
  },

  set_footprint_type: {
    disposition: "should-index",
    category: "component",
    rationale: "Placed-footprint editing belongs with component operations.",
  },
  get_component_pads: {
    disposition: "should-index",
    category: "component",
    rationale: "Pad inspection is a component query.",
  },
  get_component_list: {
    disposition: "should-index",
    category: "component",
    rationale: "Component listing is a supported component query.",
  },
  get_pad_position: {
    disposition: "should-index",
    category: "component",
    rationale: "Pad-position lookup supports placement and routing workflows.",
  },
  place_component_array: {
    disposition: "should-index",
    category: "component",
    rationale: "Array placement is a component placement operation.",
  },
  align_components: {
    disposition: "should-index",
    category: "component",
    rationale: "Alignment is a component placement operation.",
  },
  check_courtyard_overlaps: {
    disposition: "should-index",
    category: "component",
    rationale: "Courtyard overlap inspection is part of footprint placement.",
  },
  suggest_placement: {
    disposition: "should-index",
    category: "component",
    rationale: "Placement suggestion is a supported component-layout operation.",
  },
  duplicate_component: {
    disposition: "should-index",
    category: "component",
    rationale: "Component duplication is a supported board edit.",
  },

  route_arc_trace: {
    disposition: "should-index",
    category: "routing",
    rationale: "Arc routing is a routing operation.",
  },
  delete_trace: {
    disposition: "should-index",
    category: "routing",
    rationale: "Trace deletion is a routing mutation.",
  },
  query_traces: {
    disposition: "should-index",
    category: "routing",
    rationale: "Trace query is a routing inspection operation.",
  },
  query_zones: {
    disposition: "should-index",
    category: "routing",
    rationale: "Copper-zone query is a routing/board-copper inspection operation.",
  },
  add_gnd_stitching_vias: {
    disposition: "should-index",
    category: "routing",
    rationale: "Ground stitching is a routing operation.",
  },
  get_nets_list: {
    disposition: "should-index",
    category: "routing",
    rationale: "Board-net listing supports routing workflows.",
  },
  modify_trace: {
    disposition: "should-index",
    category: "routing",
    rationale: "Trace modification is a routing mutation.",
  },
  create_netclass: {
    disposition: "should-index",
    category: "routing",
    rationale: "Netclass creation configures routing constraints.",
  },
  route_differential_pair: {
    disposition: "should-index",
    category: "routing",
    rationale: "Differential-pair routing is a routing operation.",
  },
  refill_zones: {
    disposition: "should-index",
    category: "routing",
    rationale: "Zone refill is a copper-routing operation.",
  },
  route_pad_to_pad: {
    disposition: "should-index",
    category: "routing",
    rationale: "Pad-to-pad routing is the documented preferred routing path.",
  },
  copy_routing_pattern: {
    disposition: "should-index",
    category: "routing",
    rationale: "Routing-pattern replication is a supported routing operation.",
  },

  delete_schematic_component: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Placed-symbol deletion is a schematic authoring operation.",
  },
  edit_schematic_component: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Placed-symbol editing is a schematic authoring operation.",
  },
  set_schematic_component_property: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Schematic component property mutation is authoring behavior.",
  },
  remove_schematic_component_property: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Schematic component property removal is authoring behavior.",
  },
  get_schematic_component: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Placed-symbol inspection belongs to schematic discovery.",
  },
  get_schematic_pin_locations: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Pin-location lookup supports schematic connectivity.",
  },
  move_schematic_net_label: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Net-label movement is a schematic edit.",
  },
  run_erc: {
    disposition: "should-index",
    category: "drc",
    rationale: "ERC is an electrical validation gate and belongs with DRC/validation discovery.",
  },
  get_schematic_view_region: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Regional schematic rendering is a schematic inspection tool.",
  },
  find_overlapping_elements: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Overlap inspection supports schematic quality checks.",
  },
  get_elements_in_region: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Regional element query is a schematic inspection tool.",
  },
  find_wires_crossing_symbols: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Wire/symbol crossing inspection supports schematic quality checks.",
  },
  list_floating_labels: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Floating-label inspection supports schematic connectivity checks.",
  },
  find_orphaned_wires: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Orphaned-wire inspection supports schematic connectivity checks.",
  },
  snap_to_grid: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Grid snapping repairs schematic connectivity geometry.",
  },
  get_net_at_point: {
    disposition: "should-index",
    category: "schematic",
    rationale: "Point-to-net lookup is a schematic connectivity query.",
  },
  add_schematic_hierarchical_label: {
    disposition: "should-index",
    category: "schematic_hierarchy",
    rationale: "Hierarchical labels are part of multi-sheet schematic authoring.",
  },
  add_sheet_pin: {
    disposition: "should-index",
    category: "schematic_hierarchy",
    rationale: "Sheet pins are part of hierarchical schematic authoring.",
  },
  suggest_schematic_declutter: {
    disposition: "should-index",
    category: "schematic_layout",
    rationale: "Decluttering is a schematic layout operation.",
  },

  create_footprint: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Footprint creation is a supported public authoring surface.",
  },
  add_footprint_3d_model: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Footprint 3D-model attachment belongs with footprint authoring.",
  },
  import_3d_model: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Project-local 3D-model import supports footprint authoring.",
  },
  add_component_3d_model: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Placed-footprint 3D-model attachment is a supported ECAD operation.",
  },
  edit_footprint_pad: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Pad editing belongs with footprint authoring.",
  },
  register_footprint_library: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Footprint-library registration supports footprint discovery and authoring.",
  },
  list_footprint_libraries: {
    disposition: "should-index",
    category: "footprint",
    rationale: "Footprint-library listing supports footprint discovery.",
  },

  enrich_datasheets: {
    disposition: "should-index",
    category: "datasheet",
    rationale: "Datasheet enrichment is an advertised component-data workflow.",
  },
  get_datasheet_url: {
    disposition: "should-index",
    category: "datasheet",
    rationale: "Datasheet lookup is an advertised component-data workflow.",
  },

  download_jlcpcb_database: {
    disposition: "should-index",
    category: "jlcpcb",
    rationale: "JLCPCB database maintenance is a supported integration tool.",
  },
  search_jlcpcb_parts: {
    disposition: "should-index",
    category: "jlcpcb",
    rationale: "JLCPCB part search is a supported integration tool.",
  },
  get_jlcpcb_part: {
    disposition: "should-index",
    category: "jlcpcb",
    rationale: "JLCPCB part detail is a supported integration tool.",
  },
  get_jlcpcb_database_stats: {
    disposition: "should-index",
    category: "jlcpcb",
    rationale: "JLCPCB database status is a supported integration query.",
  },
  suggest_jlcpcb_alternatives: {
    disposition: "should-index",
    category: "jlcpcb",
    rationale: "JLCPCB alternative search is a supported integration tool.",
  },

  import_eagle_project: {
    disposition: "should-index",
    category: "eagle_import",
    rationale: "Eagle project conversion is a supported import operation.",
  },

  list_tool_categories: {
    disposition: "intentional-direct-only",
    rationale:
      "Meta-discovery entrypoint is invoked directly; indexing discovery controls inside their own catalogue is circular.",
  },
  get_category_tools: {
    disposition: "intentional-direct-only",
    rationale:
      "Meta-discovery entrypoint is invoked directly after listing categories; self-indexing adds no ECAD capability.",
  },
  search_tools: {
    disposition: "intentional-direct-only",
    rationale:
      "Keyword-search entrypoint is invoked directly; returning itself from keyword search is circular.",
  },
};
