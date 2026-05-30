import type { AnyAgentTool } from "../agents/tools/common.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";
import type { OpenClawPluginToolFactory } from "./tool-types.js";

export type PluginCallbackScope = {
  pluginId: string;
  pluginSource?: string;
};

const scopedTools = new WeakMap<AnyAgentTool, Map<string, AnyAgentTool>>();

function callbackScopeKey(scope: PluginCallbackScope): string {
  return JSON.stringify([scope.pluginId, scope.pluginSource ?? null]);
}

function runWithPluginCallbackScope<T>(scope: PluginCallbackScope, run: () => T): T {
  return withPluginRuntimePluginScope(
    {
      pluginId: scope.pluginId,
      ...(scope.pluginSource ? { pluginSource: scope.pluginSource } : {}),
    },
    run,
  );
}

function isAgentTool(value: unknown): value is AnyAgentTool {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function wrapPluginToolCallbacks(scope: PluginCallbackScope, tool: AnyAgentTool): AnyAgentTool {
  const key = callbackScopeKey(scope);
  const scopedByKey = scopedTools.get(tool);
  const cached = scopedByKey?.get(key);
  if (cached) {
    return cached;
  }
  const prepareArguments = tool.prepareArguments;
  const wrapped: AnyAgentTool = {
    ...tool,
    ...(prepareArguments
      ? {
          prepareArguments(args) {
            return runWithPluginCallbackScope(scope, () =>
              Reflect.apply(prepareArguments, tool, [args]),
            );
          },
        }
      : {}),
    execute(toolCallId, params, signal, onUpdate) {
      return runWithPluginCallbackScope(
        scope,
        () =>
          Reflect.apply(tool.execute, tool, [toolCallId, params, signal, onUpdate]) as ReturnType<
            AnyAgentTool["execute"]
          >,
      );
    },
  };
  const nextScopedByKey = scopedByKey ?? new Map<string, AnyAgentTool>();
  nextScopedByKey.set(key, wrapped);
  scopedTools.set(tool, nextScopedByKey);
  return wrapped;
}

function wrapPluginToolFactoryResult(
  scope: PluginCallbackScope,
  result: ReturnType<OpenClawPluginToolFactory>,
): ReturnType<OpenClawPluginToolFactory> {
  if (Array.isArray(result)) {
    return result.map((tool) => (isAgentTool(tool) ? wrapPluginToolCallbacks(scope, tool) : tool));
  }
  return isAgentTool(result) ? wrapPluginToolCallbacks(scope, result) : result;
}

export function wrapPluginToolFactoryWithScope(
  scope: PluginCallbackScope,
  factory: OpenClawPluginToolFactory,
): OpenClawPluginToolFactory {
  return (ctx) =>
    runWithPluginCallbackScope(scope, () => wrapPluginToolFactoryResult(scope, factory(ctx)));
}
