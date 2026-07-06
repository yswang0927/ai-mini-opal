import { type Edge, type Node } from "@xyflow/react";
import ELK from "elkjs";
import { type ElkNode } from "elkjs/lib/elk.bundled";
export type DagreLayoutDirections = "TB" | "LR";
//export type ElkDirectionType = "RIGHT" | "LEFT" | "UP" | "DOWN";

export default async function autoLayout(
  nodes: Node[] = [],
  edges: Edge[] = [],
  direction: string = "RIGHT"
) {
  const isRight = direction === "RIGHT";
  const isLeft = direction === "LEFT";
  const isUp = direction === "UP";
  var targetPosition = isRight
    ? "left"
    : isLeft
    ? "right"
    : isUp
    ? "bottom"
    : "top";
  var sourcePosition = isRight
    ? "right"
    : isLeft
    ? "left"
    : isUp
    ? "top"
    : "bottom";
  const elk = new ELK();
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "POLYLINE",
      "elk.spacing.nodeNode": "50",
      "elk.spacing.edgeNode": "100",
      "elk.layered.spacing.nodeNodeBetweenLayers": "150"
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: node.measured?.width || 300,
      height: node.measured?.height || 200,
      x: node.position?.x || 0,
      y: node.position?.y || 0
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target]
    }))
  };

  const layout = await elk.layout(graph);
  if (!layout || !layout.children) {
    return {
      nodes: [],
      edges: []
    };
  }
  return {
    nodes: layout.children.map((node) => {
      const initialNode = nodes.find((n) => n.id === node.id);
      if (!initialNode) {
        throw new Error("Node not found");
      }
      return {
        ...initialNode,
        position: {
          x: node.x,
          y: node.y
        },
        sourcePosition,
        targetPosition
      } as Node;
    }),
    edges: (layout.edges ?? []).map((edge) => {
      const initialEdge = edges.find((e) => e.id === edge.id);
      if (!initialEdge) {
        throw new Error("Edge not found");
      }
      return {
        ...initialEdge,
        source: edge.sources[0],
        target: edge.targets[0]
      } as Edge;
    })
  };
}