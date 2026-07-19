import React, { useState, useEffect } from 'react';
import { getBezierPath, useReactFlow, type ConnectionLineComponentProps } from '@xyflow/react';

interface ActiveTarget {
  id: string;
  nodeId: string;
  x: number;
  y: number;
  stretchX: number;
  stretchY: number;
  distance: number;
  armLength: number;
}

// 【引力通信简易通道】：让外层画布在松手瞬间能百分百拿到当前对齐的小手目标
export let __NODEZATOR_ACTIVE_SNAP_TARGET__: { nodeId: string; handleId: string | null } | null = null;

const PROXIMITY_THRESHOLD = 150; // 感应半径
const BASE_STRETCH = 20;         // 基础弹射长度
const ACTIVE_COLOR = '#F97316';   // 橘黄色
const BASE_COLOR = '#C5CBD3';     // 默认灰色

export const NodezatorConnectionLine: React.FC<ConnectionLineComponentProps> = ({
  fromX,
  fromY,
  fromPosition,
  fromNode,
  fromHandle,
  toX,
  toY,
  toPosition,
}) => {
  const { screenToFlowPosition } = useReactFlow();
  const [activeTargets, setActiveTargets] = useState<ActiveTarget[]>([]);
  const [closestTarget, setClosestTarget] = useState<ActiveTarget | null>(null);

  useEffect(() => {
    const scanAndCalculateNodezatorPhysics = () => {
      if (!fromNode || !fromHandle) return;

      const allowedSelector =
        fromHandle.type === 'source'
          ? '.react-flow__handle[data-handlepos="left"], .react-flow__handle.target'
          : '.react-flow__handle[data-handlepos="right"], .react-flow__handle.source';

      const handleElements = document.querySelectorAll(allowedSelector);
      const targets: ActiveTarget[] = [];
      let minDistance = Infinity;
      let nearestTarget: ActiveTarget | null = null;

      handleElements.forEach((el) => {
        const nodeId = el.getAttribute('data-nodeid') || '';
        if (nodeId === fromNode.id) return;

        const handleId = el.getAttribute('data-id') || el.getAttribute('id') || '';

        const rect = el.getBoundingClientRect();
        const clientX = Math.round(rect.left + rect.width / 2);
        const clientY = Math.round(rect.top + rect.height / 2);
        const flowPos = screenToFlowPosition({ x: clientX, y: clientY });

        const dx = toX - flowPos.x;
        const dy = toY - flowPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < PROXIMITY_THRESHOLD) {
          const angle = Math.atan2(dy, dx);
          const dynamicStretch = (PROXIMITY_THRESHOLD - distance) * 0.35;
          const armLength = BASE_STRETCH + dynamicStretch;

          const targetObj: ActiveTarget = {
            id: handleId,
            nodeId: nodeId,
            x: Math.round(flowPos.x),
            y: Math.round(flowPos.y),
            stretchX: Math.round(Math.cos(angle) * armLength),
            stretchY: Math.round(Math.sin(angle) * armLength),
            distance: Math.round(distance),
            armLength: Math.round(armLength)
          };

          targets.push(targetObj);

          if (distance < minDistance) {
            minDistance = distance;
            nearestTarget = targetObj;
          }
        }
      });

      setActiveTargets(targets);

      // 判定相遇碰撞锁死
      const touchThreshold = (nearestTarget ? (nearestTarget as ActiveTarget).armLength : 0) + 25;
      if (minDistance < touchThreshold && nearestTarget) {
        setClosestTarget(nearestTarget);
        // 实时塞入单例通道
        __NODEZATOR_ACTIVE_SNAP_TARGET__ = {
          nodeId: (nearestTarget as ActiveTarget).nodeId,
          handleId: (nearestTarget as ActiveTarget).id
        };
      } else {
        setClosestTarget(null);
        if (__NODEZATOR_ACTIVE_SNAP_TARGET__?.handleId === nearestTarget?.id) {
          __NODEZATOR_ACTIVE_SNAP_TARGET__ = null;
        }
      }
    };

    scanAndCalculateNodezatorPhysics();

    return () => {
      // 全局指针复位放权
      __NODEZATOR_ACTIVE_SNAP_TARGET__ = null;
    };
  }, [toX, toY, fromNode, fromHandle, screenToFlowPosition]);

  const finalTargetX = closestTarget ? (closestTarget.x + closestTarget.stretchX) : toX;
  const finalTargetY = closestTarget ? (closestTarget.y + closestTarget.stretchY) : toY;

  const [smoothEdgePath] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: finalTargetX,
    targetY: finalTargetY,
    targetPosition: toPosition,
  });

  return (
    <g className="nodezator-magnetic-field" style={{ pointerEvents: 'none' }}>
      <path d={smoothEdgePath} fill="none" stroke={closestTarget ? ACTIVE_COLOR : '#FFB946'} strokeWidth={2.5} />
      <circle cx={fromX} cy={fromY} fill={ACTIVE_COLOR} r={5} />
      <circle cx={toX} cy={toY} fill={ACTIVE_COLOR} r={6} />

      {activeTargets.map((target) => {
        const isCurrentClosest = closestTarget && target.id === closestTarget.id;
        const handX = target.x + target.stretchX;
        const handY = target.y + target.stretchY;

        return (
          <g key={target.id}>
            <line x1={target.x} y1={target.y} x2={handX} y2={handY} stroke={isCurrentClosest ? ACTIVE_COLOR : BASE_COLOR} strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={handX} cy={handY} fill={isCurrentClosest ? ACTIVE_COLOR : BASE_COLOR} r={isCurrentClosest ? 10 : 4 + (target.armLength / PROXIMITY_THRESHOLD) * 12} />
          </g>
        );
      })}
    </g>
  );
};