// Tool metadata registration tests cover plugin-owned metadata snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildEffectiveToolInventoryEntries } from "../../agents/tools-effective-inventory-build.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { PluginToolMetadataRegistration } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { setPluginToolMeta } from "../tools.js";

describe("plugin tool metadata registration", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("snapshots metadata before effective tool inventory projection", () => {
    let toolNameReads = 0;
    let displayNameReads = 0;
    let descriptionReads = 0;
    let riskReads = 0;
    let tagsReads = 0;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-metadata",
        name: "Volatile Metadata",
        contracts: { tools: ["volatile_tool"] },
      }),
      register(api) {
        api.registerToolMetadata({
          get toolName() {
            toolNameReads += 1;
            if (toolNameReads > 1) {
              throw new Error("toolName getter re-read");
            }
            return "volatile_tool";
          },
          get displayName() {
            displayNameReads += 1;
            if (displayNameReads > 1) {
              throw new Error("displayName getter re-read");
            }
            return "Volatile Tool";
          },
          get description() {
            descriptionReads += 1;
            if (descriptionReads > 1) {
              throw new Error("description getter re-read");
            }
            return "Stable metadata description.";
          },
          get risk() {
            riskReads += 1;
            if (riskReads > 1) {
              throw new Error("risk getter re-read");
            }
            return "medium";
          },
          get tags() {
            tagsReads += 1;
            if (tagsReads > 1) {
              throw new Error("tags getter re-read");
            }
            return ["metadata", "fixture"];
          },
        } as PluginToolMetadataRegistration);
      },
    });
    setActivePluginRegistry(registry.registry);

    const tool = {
      name: "volatile_tool",
      label: "Raw label",
      description: "Raw description",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "ok" }),
    } as unknown as AnyAgentTool;
    setPluginToolMeta(tool, { pluginId: "volatile-metadata", optional: false });

    expect(buildEffectiveToolInventoryEntries([tool])).toEqual([
      {
        id: "volatile_tool",
        label: "Volatile Tool",
        description: "Stable metadata description.",
        rawDescription: "Stable metadata description.",
        source: "plugin",
        pluginId: "volatile-metadata",
        risk: "medium",
        tags: ["metadata", "fixture"],
      },
    ]);
    expect(toolNameReads).toBe(1);
    expect(displayNameReads).toBe(1);
    expect(descriptionReads).toBe(1);
    expect(riskReads).toBe(1);
    expect(tagsReads).toBe(1);
  });
});
