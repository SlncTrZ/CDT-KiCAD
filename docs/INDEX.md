# Documentation

| Task | Reference |
| --- | --- |
| Install and start | [README](../README.md), [client configuration](CLIENT_CONFIGURATION.md), [release & deployment](RELEASE_AND_DEPLOYMENT.md) |
| Platform-specific setup | [Platform guide](PLATFORM_GUIDE.md), [Windows troubleshooting](WINDOWS_TROUBLESHOOTING.md) |
| Callable contract and discovery | [Runtime guide](TOOL_GUIDE.md), [generated inventory](TOOL_INVENTORY.md) |
| Schematic operations | [Schematic reference](SCHEMATIC_TOOLS_REFERENCE.md), [headless authoring](HEADLESS_AUTHORING.md) |
| Board and routing | [PCB workflow](PCB_DESIGN_WORKFLOW.md), [routing reference](ROUTING_TOOLS_REFERENCE.md), [Freerouting](FREEROUTING_GUIDE.md) |
| Custom libraries/assets | [Footprint/symbol creation](FOOTPRINT_SYMBOL_CREATOR_GUIDE.md), [library setup](LIBRARY_INTEGRATION.md), [SVG import](SVG_IMPORT_GUIDE.md) |
| Parts and datasheets | [JLCPCB setup/API](JLCPCB_INTEGRATION.md), [usage examples](JLCPCB_USAGE_GUIDE.md), [datasheets](DATASHEET_TOOLS_GUIDE.md) |
| Optional GUI lane | [IPC behavior](IPC_BACKEND_STATUS.md), [realtime workflow](REALTIME_WORKFLOW.md), [visual feedback](VISUAL_FEEDBACK.md), [UI launch](UI_AUTO_LAUNCH.md) |
| Gateway integration | [SlncTrZ integration](SLNCTRZ_INTEGRATION.md) |
| Troubleshoot | [Known issues](KNOWN_ISSUES.md) |
| Contribute | [Validation](../CONTRIBUTING.md), [architecture](ARCHITECTURE.md) |
| Measured native procedure | [Windows acceptance](WINDOWS_NATIVE_ACCEPTANCE.md) |
| Release history and origin | [Fork changes](../CHANGELOG.md), [attribution](../ATTRIBUTION.md) |

The declared accepted target is KiCad 10.0.6 / Windows 11 / CLI-native.
Optional GUI/OS capabilities need their own runtime proof.
All registered tools are directly callable. Use `list_tool_categories`,
`get_category_tools` and `search_tools` to find their real schemas;
no indirect `execute_tool` gate is shipped.
