import { pluginRegistry } from "../registry";
import { LLMToolsPlugin } from "../types";
import { LLMTool, ToolReturnTag } from "../../type";

export function registerLLMToolsPlugins(): void {
  pluginRegistry.register({
    name: "volume-control",
    displayName: "Volume Control Tools",
    version: "1.0.0",
    type: "llm-tools",
    description: "Built-in volume control tools (set / increase / decrease)",
    activate: () => {
      const {
        setVolumeByAmixer,
        getCurrentLogPercent,
      } = require("../../utils/volume");
      return {
        getTools: (): LLMTool[] => [
          {
            execution: "bounded",
            type: "function",
            function: {
              name: "setVolume",
              description: "set the volume level",
              parameters: {
                type: "object",
                properties: {
                  percent: {
                    type: "number",
                    minimum: 0,
                    maximum: 100,
                    description: "the volume level to set (0-100)",
                  },
                },
                required: ["percent"],
              },
            },
            func: async (params: any) => {
              const { percent } = params;
              if (percent >= 0 && percent <= 100) {
                setVolumeByAmixer(percent);
                return `${ToolReturnTag.Success}Volume set to ${percent}%`;
              }
              console.error("Volume range error");
              return `${ToolReturnTag.Error}Volume range error, please set between 0 and 100`;
            },
          },
          {
            execution: "bounded",
            type: "function",
            function: {
              name: "increaseVolume",
              description: "increase the volume level by a specified amount",
              parameters: {
                type: "object",
                properties: {},
              },
            },
            func: async () => {
              const currentLogPercent = getCurrentLogPercent();
              if (currentLogPercent >= 100) {
                return `${ToolReturnTag.Success}Volume is already at maximum`;
              }
              const newAmixerValue = Math.min(currentLogPercent + 10, 100);
              setVolumeByAmixer(newAmixerValue);
              console.log(
                `Current volume: ${currentLogPercent}%, New volume: ${newAmixerValue}%`,
              );
              return `${ToolReturnTag.Success}Volume increased by 10%, now at ${newAmixerValue}%`;
            },
          },
          {
            execution: "bounded",
            type: "function",
            function: {
              name: "decreaseVolume",
              description: "decrease the volume level by a specified amount",
              parameters: {
                type: "object",
                properties: {},
              },
            },
            func: async () => {
              const currentLogPercent = getCurrentLogPercent();
              if (currentLogPercent <= 0) {
                return `${ToolReturnTag.Success}Volume is already at minimum`;
              }
              const newAmixerValue = Math.max(currentLogPercent - 10, 0);
              setVolumeByAmixer(newAmixerValue);
              console.log(
                `Current volume: ${currentLogPercent}%, New volume: ${newAmixerValue}%`,
              );
              return `${ToolReturnTag.Success}Volume decreased by 10%, now at ${newAmixerValue}%`;
            },
          },
        ],
      };
    },
  } as LLMToolsPlugin);
}
