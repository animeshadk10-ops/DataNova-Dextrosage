import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  Connection,
  Edge,
  Node,
  Panel,
  MiniMap
} from '@xyflow/react';
import { nodeTypes } from './CanvasNodes';
import { executeCanvasNode, fetchScatterData, fetchBoxPlotData, fetchHeatMapData, fetchDatasetStats } from '@/lib/api';
import OnboardingOverlay from './OnboardingOverlay';

const initialNodes: Node[] = [];
const initialEdges: Edge[] = [];

const getId = () => {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

export default function DeveloperCanvasWrapper({ sessionId }: { sessionId: string }) {
  return (
    <ReactFlowProvider>
      <DeveloperCanvas sessionId={sessionId} />
    </ReactFlowProvider>
  );
}

function DeveloperCanvas({ sessionId }: { sessionId: string }) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const executionTimeout = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (nodes.length === 0 && sessionId) {
      const newNode: Node = {
        id: 'file_node_1',
        type: 'FileNode',
        position: { x: 250, y: 150 },
        data: { sessionId },
      };
      setNodes([newNode]);
      triggerExecution([newNode], edges);
    }
  }, [sessionId, nodes.length, setNodes]);

  const onConnect = useCallback(
    (params: Connection | Edge) => {
      const newEdges = addEdge(params, edges);
      setEdges(newEdges);
      triggerExecution(nodes, newEdges);
    },
    [edges, nodes, setEdges]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleNodeConfigChange = useCallback((nodeId: string, newConfig: any) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === nodeId) {
          return {
            ...n,
            data: {
              ...n.data,
              config: { ...(n.data.config || {}), ...newConfig },
            },
          };
        }
        return n;
      })
    );
    setTimeout(() => {
      setNodes((currentNodes) => {
        triggerExecution(currentNodes, edges);
        return currentNodes;
      });
    }, 100);
  }, [edges, setNodes]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (!reactFlowWrapper.current || !reactFlowInstance) return;

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      let initialStyle = undefined;
      if (['ScatterPlotNode', 'BoxPlotNode', 'HeatMapNode', 'ModelCompareNode'].includes(type)) {
        initialStyle = { width: 560, height: 420 };
      } else if (type === 'DataTableNode') {
        initialStyle = { width: 400, height: 300 };
      } else if (type === 'StatsNode') {
        initialStyle = { width: 350, height: 280 };
      } else if (type === 'MLTrainNode') {
        initialStyle = { width: 380, height: 350 };
      }

      const newNode: Node = {
        id: `node_${getId()}`,
        type,
        position,
        style: initialStyle,
        data: {
          onChange: handleNodeConfigChange,
          config: {}
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes, handleNodeConfigChange]
  );

  const triggerExecution = (currentNodes: Node[], currentEdges: Edge[]) => {
    if (executionTimeout.current) {
      clearTimeout(executionTimeout.current);
    }
    executionTimeout.current = setTimeout(() => {
      executeGraph(currentNodes, currentEdges);
    }, 800);
  };

  const setNodeExecuting = (nodeId: string, isExecuting: boolean) => {
    setNodes((nds) => nds.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, isExecuting } } : n
    ));
  };

  const executeGraph = async (currentNodes: Node[], currentEdges: Edge[]) => {
    if (!sessionId) return;

    let updatedNodes = [...currentNodes];
    const fileNode = updatedNodes.find(n => n.type === 'FileNode');
    if (!fileNode) return;

    const nodeOutputs: Record<string, string> = {};

    try {
      const fileRes = await executeCanvasNode({
        session_id: sessionId,
        node_type: 'FileNode',
        config: {},
        node_id: fileNode.id,
      });

      nodeOutputs[fileNode.id] = fileRes.node_output_id;

      updatedNodes = updatedNodes.map(n =>
        n.id === fileNode.id ? { ...n, data: { ...n.data, preview: fileRes.preview, error: null } } : n
      );
      setNodes(updatedNodes);

      const queue = [fileNode.id];
      const executed = new Set([fileNode.id]);

      const nodeColumns: Record<string, { name: string; type: string }[]> = {};
      if (fileRes.preview?.columns) {
        nodeColumns[fileNode.id] = fileRes.preview.columns;
      }

      while (queue.length > 0) {
        const currId = queue.shift()!;
        const availableColumns = nodeColumns[currId] || [];

        const childrenEdges = currentEdges.filter(e => e.source === currId);

        for (const edge of childrenEdges) {
          const childId = edge.target;
          if (executed.has(childId)) continue;

          const childNode = updatedNodes.find(n => n.id === childId);
          if (!childNode) continue;

          setNodeExecuting(childId, true);

          try {
            const config = childNode.data.config as any || {};

            // Visualization nodes get special handling
            if (childNode.type === 'ScatterPlotNode') {
              if (config.x_col && config.y_col) {
                const res = await fetchScatterData(sessionId, config.x_col, config.y_col, config.color_col, nodeOutputs[currId]);
                updatedNodes = updatedNodes.map(n =>
                  n.id === childId ? { ...n, data: { ...n.data, preview: { vizData: res }, availableColumns, error: null, isExecuting: false } } : n
                );
              } else {
                updatedNodes = updatedNodes.map(n => n.id === childId ? { ...n, data: { ...n.data, availableColumns, error: null, isExecuting: false } } : n);
              }
              nodeOutputs[childId] = nodeOutputs[currId];
              nodeColumns[childId] = availableColumns;

            } else if (childNode.type === 'BoxPlotNode') {
              if (config.value_col) {
                const res = await fetchBoxPlotData(sessionId, config.value_col, config.group_col, nodeOutputs[currId]);
                updatedNodes = updatedNodes.map(n =>
                  n.id === childId ? { ...n, data: { ...n.data, preview: { vizData: res }, availableColumns, error: null, isExecuting: false } } : n
                );
              } else {
                updatedNodes = updatedNodes.map(n => n.id === childId ? { ...n, data: { ...n.data, availableColumns, error: null, isExecuting: false } } : n);
              }
              nodeOutputs[childId] = nodeOutputs[currId];
              nodeColumns[childId] = availableColumns;

            } else if (childNode.type === 'HeatMapNode') {
              let cols;
              if (config.columns) {
                cols = config.columns.split(',').map((s: string) => s.trim()).filter(Boolean);
              }
              const res = await fetchHeatMapData(sessionId, cols, nodeOutputs[currId]);
              updatedNodes = updatedNodes.map(n =>
                n.id === childId ? { ...n, data: { ...n.data, preview: { vizData: res }, availableColumns, error: null, isExecuting: false } } : n
              );
              nodeOutputs[childId] = nodeOutputs[currId];
              nodeColumns[childId] = availableColumns;

            } else if (childNode.type === 'StatsNode') {
              const res = await fetchDatasetStats(sessionId, nodeOutputs[currId]);
              updatedNodes = updatedNodes.map(n =>
                n.id === childId ? { ...n, data: { ...n.data, preview: { stats: res }, availableColumns, error: null, isExecuting: false } } : n
              );
              nodeOutputs[childId] = nodeOutputs[currId];
              nodeColumns[childId] = availableColumns;

            } else if (childNode.type === 'ModelCompareNode') {
              // ModelCompare reads from upstream MLTrainNode output
              nodeOutputs[childId] = nodeOutputs[currId];
              nodeColumns[childId] = availableColumns;
              const upstreamNode = updatedNodes.find(n => n.id === currId);
              updatedNodes = updatedNodes.map(n =>
                n.id === childId ? { ...n, data: { ...n.data, preview: upstreamNode?.data?.preview || {}, availableColumns, error: null, isExecuting: false } } : n
              );

            } else if (childNode.type === 'RenameColumnNode') {
              // RenameColumn needs special handling - column names change
              const res = await executeCanvasNode({
                session_id: sessionId,
                node_type: childNode.type!,
                config: config,
                upstream_node_output_id: nodeOutputs[currId],
                node_id: childId,
              });
              nodeOutputs[childId] = res.node_output_id;
              if (res.preview?.columns) {
                nodeColumns[childId] = res.preview.columns;
              }
              updatedNodes = updatedNodes.map(n =>
                n.id === childId ? { ...n, data: { ...n.data, preview: res.preview, availableColumns: res.preview?.columns || availableColumns, error: null, isExecuting: false } } : n
              );

            } else if (childNode.type === 'EncodeNode') {
              // Encode can create/remove columns
              const res = await executeCanvasNode({
                session_id: sessionId,
                node_type: childNode.type!,
                config: config,
                upstream_node_output_id: nodeOutputs[currId],
                node_id: childId,
              });
              nodeOutputs[childId] = res.node_output_id;
              if (res.preview?.columns) {
                nodeColumns[childId] = res.preview.columns;
              }
              updatedNodes = updatedNodes.map(n =>
                n.id === childId ? { ...n, data: { ...n.data, preview: res.preview, availableColumns: res.preview?.columns || availableColumns, error: null, isExecuting: false } } : n
              );

            } else {
              // Generic execution for all other nodes
              const res = await executeCanvasNode({
                session_id: sessionId,
                node_type: childNode.type!,
                config: config,
                upstream_node_output_id: nodeOutputs[currId],
                node_id: childId,
              });

              nodeOutputs[childId] = res.node_output_id;
              if (res.preview?.columns) {
                nodeColumns[childId] = res.preview.columns;
              }

              updatedNodes = updatedNodes.map(n =>
                n.id === childId ? { ...n, data: { ...n.data, preview: res.preview, availableColumns, error: null, isExecuting: false } } : n
              );
            }
            setNodes(updatedNodes);

            executed.add(childId);
            queue.push(childId);

          } catch (err: any) {
            const errMsg = err.response?.data?.detail || err.message || 'Execution failed';
            updatedNodes = updatedNodes.map(n =>
              n.id === childId ? { ...n, data: { ...n.data, error: errMsg, isExecuting: false } } : n
            );
            setNodes(updatedNodes);
          }
        }
      }
    } catch (e) {
      console.error("Canvas execution error:", e);
    }
  };

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const SidebarItem = ({ icon, label, nodeType, category, tooltip }: { icon: string; label: string; nodeType: string; category: string; tooltip: string }) => (
    <div
      className="glass-card p-2 text-sm cursor-grab border border-border-subtle hover:border-[var(--warning)] transition-colors relative group"
      onDragStart={(e) => onDragStart(e, nodeType)}
      draggable
    >
      {icon} {label}
      <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 bg-surface border border-border-subtle text-[10px] px-2 py-1 rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none w-max z-50 transition-opacity">
        {tooltip}
      </div>
    </div>
  );

  return (
    <div className="flex h-full w-full">
      {/* Sidebar Palette */}
      <div className="w-64 bg-surface-elevated border-r border-border-subtle p-4 flex flex-col gap-4 shrink-0 overflow-y-auto custom-scrollbar">
        {/* Data */}
        <div>
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2 border-b border-border-subtle pb-1">Data</h3>
          <div className="flex flex-col gap-1.5">
            <SidebarItem icon="📄" label="File / Session" nodeType="FileNode" category="data" tooltip="Entry point for your uploaded dataset" />
            <SidebarItem icon="📊" label="Data Preview" nodeType="DataTableNode" category="data" tooltip="View rows and columns as a table" />
            <SidebarItem icon="📋" label="Dataset Stats" nodeType="StatsNode" category="data" tooltip="Comprehensive column statistics" />
          </div>
        </div>

        {/* Transforms */}
        <div>
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2 border-b border-border-subtle pb-1">Transform</h3>
          <div className="flex flex-col gap-1.5">
            <SidebarItem icon="💉" label="Impute" nodeType="ImputeNode" category="transform" tooltip="Fill missing values (median/mode)" />
            <SidebarItem icon="🗑️" label="Drop Column" nodeType="DropColumnNode" category="transform" tooltip="Remove a column entirely" />
            <SidebarItem icon="✂️" label="Clip Outliers" nodeType="ClipOutliersNode" category="transform" tooltip="Cap extreme values at robust bounds" />
            <SidebarItem icon="🔗" label="Merge Categories" nodeType="MergeCategoriesNode" category="transform" tooltip="Group tiny tail categories into Other" />
            <SidebarItem icon="📈" label="Log Transform" nodeType="LogTransformNode" category="transform" tooltip="Apply log(1+x) to reduce skew" />
          </div>
        </div>

        {/* Advanced Transforms */}
        <div>
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2 border-b border-border-subtle pb-1">Advanced</h3>
          <div className="flex flex-col gap-1.5">
            <SidebarItem icon="🔍" label="Filter Rows" nodeType="FilterRowsNode" category="transform" tooltip="Keep rows matching a condition" />
            <SidebarItem icon="↕️" label="Sort Rows" nodeType="SortNode" category="transform" tooltip="Sort by column ascending/descending" />
            <SidebarItem icon="✏️" label="Rename Column" nodeType="RenameColumnNode" category="transform" tooltip="Rename a column" />
            <SidebarItem icon="🔄" label="Type Cast" nodeType="TypeCastNode" category="transform" tooltip="Change column data type" />
            <SidebarItem icon="🔢" label="Encode Categories" nodeType="EncodeNode" category="transform" tooltip="Label or one-hot encode categoricals" />
            <SidebarItem icon="📐" label="Scale / Normalize" nodeType="ScaleNode" category="transform" tooltip="Standard, Min-Max, or Robust scaling" />
            <SidebarItem icon="🎲" label="Sample Rows" nodeType="SampleNode" category="transform" tooltip="Take a random/head/tail sample" />
          </div>
        </div>

        {/* Visualize */}
        <div>
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2 border-b border-border-subtle pb-1">Visualize</h3>
          <div className="flex flex-col gap-1.5">
            <SidebarItem icon="📈" label="Scatter Plot" nodeType="ScatterPlotNode" category="visualize" tooltip="Plot relationships between two numeric cols" />
            <SidebarItem icon="📊" label="Box Plot" nodeType="BoxPlotNode" category="visualize" tooltip="View distributions and outliers" />
            <SidebarItem icon="🔥" label="Heat Map" nodeType="HeatMapNode" category="visualize" tooltip="View correlation matrix" />
          </div>
        </div>

        {/* ML */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-2 border-b border-border-subtle pb-1" style={{ color: '#7C3AED' }}>Machine Learning</h3>
          <div className="flex flex-col gap-1.5">
            <div
              className="glass-card p-2 text-sm cursor-grab border border-border-subtle transition-colors relative group"
              style={{ borderColor: 'rgba(124,58,237,0.3)' }}
              onDragStart={(e) => onDragStart(e, 'MLTrainNode')}
              draggable
            >
              🤖 ML Model Trainer
              <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 bg-surface border border-border-subtle text-[10px] px-2 py-1 rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none w-max z-50 transition-opacity">
                Train multiple ML models and compare accuracy
              </div>
            </div>
            <div
              className="glass-card p-2 text-sm cursor-grab border border-border-subtle transition-colors relative group"
              style={{ borderColor: 'rgba(124,58,237,0.3)' }}
              onDragStart={(e) => onDragStart(e, 'ModelCompareNode')}
              draggable
            >
              📊 Model Comparison
              <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 bg-surface border border-border-subtle text-[10px] px-2 py-1 rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none w-max z-50 transition-opacity">
                Visualize model performance with bar charts and confusion matrices
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative" ref={reactFlowWrapper}>
        {showOnboarding && (
          <OnboardingOverlay onDismiss={() => setShowOnboarding(false)} />
        )}

        <button
          onClick={() => setShowOnboarding(true)}
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-surface-elevated border border-border-subtle shadow-sm flex items-center justify-center text-text-muted hover:text-[var(--accent-primary)] hover:border-[var(--accent-primary)] transition-colors"
          title="Help & Walkthrough"
        >
          ?
        </button>

        <ReactFlow
          nodes={nodes}
          edges={edges.map(e => ({
            ...e,
            type: 'smoothstep',
            animated: nodes.find(n => n.id === e.target)?.data?.isExecuting ? true : false,
            style: { strokeWidth: 2, stroke: 'var(--accent-primary)' }
          }))}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setReactFlowInstance}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          fitView
          className="bg-bg-primary"
        >
          <Background color="var(--border-subtle)" gap={16} />
          <Controls className="bg-surface-elevated border border-border-subtle shadow-sm rounded-lg" />
          <MiniMap className="bg-surface-elevated border border-border-subtle rounded-lg shadow-sm" maskColor="var(--bg-primary)" nodeColor="var(--accent-secondary)" />
        </ReactFlow>
      </div>
    </div>
  );
}
