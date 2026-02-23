import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  useReactFlow,
  useEdges
} from 'reactflow';
import 'reactflow/dist/style.css';
import DragDropManager from '../utils/DragDropManager';
import { writeTextFile, readTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';

const logDebug = async (msg) => {
  try {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    // Append requires reading first or just overwrite for simple debugging (append is harder in simple API)
    // We will just try to append by reading first
    // NOTE: This is slow but fine for debugging 1 event
    /*
    let content = '';
    try {
        content = await readTextFile('debug_log.txt', { baseDir: BaseDirectory.Document });
    } catch(e) {}
    await writeTextFile('debug_log.txt', content + line, { baseDir: BaseDirectory.Document });
    */
    // Let's just write to console AND try a fire-and-forget write to a new file per log or just one main log without read-append for speed.
    // Actually, let's just use console.log but since user asked for file:
    // We will overwrite a file 'last_debug_op.txt' to avoid complex append logic in this context
    // await writeTextFile('plc_debug_log.txt', line, { baseDir: BaseDirectory.Home, append: true }); // append option exists in newer tauri fs?
    // Let's assum tauri v2 writeTextFile has append options? Protocol says v2.
    // Checking docs... it supports { append: true } usually.
    // Hardcoded absolute path for reliability
    await writeTextFile('/home/fehim/Documents/PLCEditor/debug_drag.txt', line, { append: true });
  } catch (err) {
    console.error("Log failed", err);
  }
};

/**
 * Her rung'un kendi mini ladder editörü
 * - Sol: Terminal - Kırmızı çizgi (fixed, canvas dışında)
 * - Orta: Bloklar (sürüklenebilir, React Flow içinde)
 * - Sağ: Terminal - Mavi çizgi (fixed, canvas dışında)
 */

// Terminal connection point - 24V ve 0V bağlantı noktaları
const TerminalConnectionPoint = ({ data, isConnectable }) => {
  const isLeft = data.position === 'left';
  const label = isLeft ? '24V' : '0V';
  const color = isLeft ? '#ff3333' : '#0066ff';

  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      pointerEvents: 'auto'
    }}>
      {/* Half-filled Circle */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: 7, // Half width
        height: 14,
        borderRadius: isLeft ? '0 14px 14px 0' : '14px 0 0 14px',
        background: color,
        border: `2px solid ${color}`,
        zIndex: 10,
        transform: isLeft ? 'translate(0, -50%)' : 'translate(-100%, -50%)'
      }}>
        <Handle
          type={isLeft ? 'source' : 'target'}
          position={isLeft ? Position.Right : Position.Left}
          id={isLeft ? 'out' : 'in'}
          isConnectable={true}
          style={{
            background: 'transparent',
            width: 24,
            height: 24,
            border: 'none',
            opacity: 0,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'all'
          }}
        />
      </div>
    </div>
  );
};

// Blok Yapılandırması ve Tip Tanımları
export const blockConfig = {
  TON: {
    label: 'TON',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TOF: {
    label: 'TOF',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TP: {
    label: 'TP',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  CTU: {
    label: 'CTU',
    inputs: [{ name: 'CU', type: 'BOOL' }, { name: 'R', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  CTD: {
    label: 'CTD',
    inputs: [{ name: 'CD', type: 'BOOL' }, { name: 'LD', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  R_TRIG: {
    label: 'R_TRIG',
    inputs: [{ name: 'CLK', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }]
  },
  F_TRIG: {
    label: 'F_TRIG',
    inputs: [{ name: 'CLK', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }]
  },
  RS: {
    label: 'RS',
    inputs: [{ name: 'S', type: 'BOOL' }, { name: 'R1', type: 'BOOL' }],
    outputs: [{ name: 'Q1', type: 'BOOL' }]
  },
  SR: {
    label: 'SR',
    inputs: [{ name: 'S1', type: 'BOOL' }, { name: 'R', type: 'BOOL' }],
    outputs: [{ name: 'Q1', type: 'BOOL' }]
  },
  Contact: { label: 'Contact', inputs: [], outputs: [] },
  Coil: { label: 'Coil', inputs: [], outputs: [] }
};

// SVG Path Helper
const getSymbolPath = (type, subType) => {
  if (type === 'Contact') {
    switch (subType) {
      case 'NC': // Normally Closed
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <line x1="8" y1="35" x2="32" y2="5" />
          </g>
        );
      case 'Rising': // Rising Edge (P)
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="14" stroke="none" fill="currentColor">P</text>
          </g>
        );
      case 'Falling': // Falling Edge (N)
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="14" stroke="none" fill="currentColor">N</text>
          </g>
        );
      case 'NO': // Normally Open (Default)
      default:
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
          </g>
        );
    }
  } else if (type === 'Coil') {
    switch (subType) {
      case 'Negated':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="5" y2="20" />
            <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
            <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
            <line x1="35" y1="20" x2="40" y2="20" />
            <line x1="10" y1="30" x2="30" y2="10" />
          </g>
        );
      case 'Set':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="5" y2="20" />
            <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
            <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
            <line x1="35" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">S</text>
          </g>
        );
      case 'Reset':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="5" y2="20" />
            <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
            <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
            <line x1="35" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">R</text>
          </g>
        );
      case 'Rising':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="5" y2="20" />
            <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
            <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
            <line x1="35" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">P</text>
          </g>
        );
      case 'Falling':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="5" y2="20" />
            <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
            <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
            <line x1="35" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">N</text>
          </g>
        );
      case 'Normal':
      default:
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="5" y2="20" />
            <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
            <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
            <line x1="35" y1="20" x2="40" y2="20" />
          </g>
        );
    }
  }
  return null;
};


const BlockNode = ({ id, data, isConnectable, selected }) => {
  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const { variables = [], globalVars = [] } = data; // Receive vars from data context


  // SAFE MODE GHOST RENDERING
  // Renders a pure visual copy without inputs/handles to prevent logic errors during drag
  // SAFE MODE GHOST RENDERING (High Fidelity Visual Replica)
  if (id === 'ghost-preview') {
    // 1. Contact/Coil Ghost
    if (data.type === 'Contact' || data.type === 'Coil') {
      const subType = data.subType || (data.type === 'Contact' ? 'NO' : 'Normal');
      const symbol = getSymbolPath(data.type, subType);
      const instanceName = data.instanceName || (data.type === 'Contact' ? (data.values?.var || '') : (data.values?.coil || ''));
      // Visual Clone of Contact/Coil
      return (
        <div style={{
          position: 'relative', width: 24, height: 24, minWidth: 24, minHeight: 24,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255, 255, 255, 0.05)', // Match real block
          border: '1px solid transparent', // Match real block when not selected
          borderRadius: 4,
          opacity: 0.8 // Slightly transparent for ghost effect
        }}>
          {/* Fake Input for visual consistency */}
          <div style={{
            position: 'absolute', top: -30, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center'
          }}>
            <div style={{
              width: 80, height: 20, fontSize: 11, border: '1px solid #333', background: '#252526', color: 'white',
              borderRadius: 2, padding: '0 4px', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden'
            }}>
              {instanceName || '??'}
            </div>
          </div>
          <svg width="24" height="24" viewBox="0 0 40 40" style={{ color: '#fff', overflow: 'visible' }}>{symbol}</svg>
        </div>
      );
    }

    // 2. Standard Block Ghost (TON, CTU, etc.) - High Fidelity Clone
    let ghostCfg = blockConfig[data.type];
    // Custom block handling
    if (data.customData && data.customData.content) {
      const variables = data.customData.content?.variables || [];
      ghostCfg = {
        label: data.customData.name,
        inputs: variables.filter(v => v.class === 'Input' || v.class === 'InOut').map(v => ({ name: v.name, type: v.type })),
        outputs: variables.filter(v => v.class === 'Output').map(v => ({ name: v.name, type: v.type }))
      };
      if (data.customData.returnType) ghostCfg.outputs.push({ name: 'OUT', type: data.customData.returnType });
    }
    if (!ghostCfg) ghostCfg = { label: data.type, inputs: [], outputs: [] };

    // Execution Control Simulation
    const ghostInputs = data.executionControl ? [{ name: 'EN', type: 'BOOL' }, ...ghostCfg.inputs] : ghostCfg.inputs;
    const ghostOutputs = data.executionControl ? [{ name: 'ENO', type: 'BOOL' }, ...ghostCfg.outputs] : ghostCfg.outputs;

    return (
      <div style={{
        background: '#252526',
        border: '1px solid #666',
        borderRadius: 4,
        minWidth: 140,
        color: '#fff',
        fontSize: 11,
        overflow: 'hidden',
        boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
        opacity: 0.9
      }}>
        {/* Header */}
        <div style={{
          background: '#333', padding: '2px 4px', textAlign: 'center', fontSize: '10px', color: '#ccc', borderBottom: '1px solid #444'
        }}>
          {data.instanceName || `${data.type}_?`}
        </div>
        {/* Label */}
        <div style={{ background: '#0d47a1', padding: '4px 8px', textAlign: 'center', fontWeight: 'bold' }}>
          {ghostCfg.label}
        </div>

        {/* Pins Body */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px' }}>
          {/* INPUTS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ghostInputs.map((pin, i) => (
              <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 20 }}>
                {/* Fake Handle */}
                <div style={{ width: 10, height: 10, background: '#4CAF50', marginLeft: -14, border: '1px solid #fff', borderRadius: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 'bold', marginLeft: 6 }}>{pin.name}</span>
              </div>
            ))}
          </div>
          {/* OUTPUTS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end', marginLeft: 10 }}>
            {ghostOutputs.map((pin, i) => (
              <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 20, justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 10, fontWeight: 'bold', marginRight: 6 }}>{pin.name}</span>
                {/* Fake Handle */}
                <div style={{ width: 10, height: 10, background: '#FF5722', marginRight: -14, border: '1px solid #fff', borderRadius: 0 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const handleUpdate = useCallback((updates) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id === id) {
        const newData = { ...n.data, ...updates };
        // Sync values if instanceName changes
        if (updates.instanceName) {
          newData.values = {
            ...(newData.values || {}),
            ...(newData.type === 'Contact' ? { var: updates.instanceName } : {}),
            ...(newData.type === 'Coil' ? { coil: updates.instanceName } : {})
          };
        }
        if (data.onUpdate) data.onUpdate(id, updates);
        return { ...n, data: newData };
      }
      return n;
    }));
  }, [id, setNodes, data]);

  // Contact ve Coil için Özel Render
  if (data.type === 'Contact' || data.type === 'Coil') {
    const subType = data.subType || (data.type === 'Contact' ? 'NO' : 'Normal');
    const symbol = getSymbolPath(data.type, subType);
    const instanceName = data.instanceName || (data.type === 'Contact' ? (data.values?.var || '') : (data.values?.coil || '')); // Default to empty string for placeholder

    const cycleType = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const contactTypes = ['NO', 'NC', 'Rising', 'Falling'];
      const coilTypes = ['Normal', 'Negated', 'Set', 'Reset', 'Rising', 'Falling'];
      const types = data.type === 'Contact' ? contactTypes : coilTypes;
      const currentIdx = types.indexOf(subType);
      const nextType = types[(currentIdx + 1) % types.length];
      handleUpdate({ subType: nextType });
    };

    return (
      <div style={{
        position: 'relative',
        width: 24,
        height: 24,
        minWidth: 24, // Explicit min width
        minHeight: 24, // Explicit min height
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        background: 'rgba(255, 255, 255, 0.05)',
        border: selected ? '2px solid #007acc' : (
          ((data.type === 'Contact' || data.type === 'Coil') &&
            ![...variables, ...globalVars].some(v => v.name === instanceName) && instanceName !== '')
            ? '2px solid #f44336' // RED ERROR BORDER
            : '1px solid transparent'
        ),
        borderRadius: 4
      }}>
        {/* Interactive Controls (Top) */}
        <div style={{
          position: 'absolute',
          top: -30,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          zIndex: 10
        }} onClick={(e) => e.stopPropagation()}>
          {/* Variable Input */}
          <input
            className="nodrag"
            value={instanceName}
            onChange={(e) => {
              const val = e.target.value.replace(/[🌍🏠]/g, '').trim();
              handleUpdate({ instanceName: val });
            }}
            list="ladder-vars-BOOL"
            placeholder="??"
            style={{
              width: 80,
              height: 20,
              fontSize: 11,
              border: selected ? '1px solid #007acc' : '1px solid #333',
              background: '#252526',
              color: 'white',
              borderRadius: 2,
              padding: '0 4px',
              outline: 'none',
              textAlign: 'center'
            }}
          />
          {/* Type Toggle Button */}
          <div
            onClick={cycleType}
            className="nodrag"
            style={{
              height: 20,
              padding: '0 6px',
              background: '#007acc',
              color: 'white',
              fontSize: 10,
              fontWeight: 'bold',
              borderRadius: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 24,
              userSelect: 'none'
            }}
            title={`Current Type: ${subType}. Click to change.`}
          >
            {subType === 'Normal' ? 'N' : subType.substring(0, 3)}
          </div>
        </div>

        {/* SVG Symbol */}
        <svg width="24" height="24" viewBox="0 0 40 40" style={{ color: selected ? '#007acc' : '#fff', overflow: 'visible' }}>
          {symbol}
        </svg>

        {/* Handles */}
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          isConnectable={true}
          style={{
            width: 8,
            height: 8,
            background: 'transparent',
            left: -4,
            top: '50%',
            transform: 'translateY(-50%)',
            border: 'none',
            opacity: 0,
            zIndex: 5
          }}
        />
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          isConnectable={true}
          style={{
            background: 'transparent',
            width: 8,
            height: 8,
            right: -4,
            top: '50%',
            transform: 'translateY(-50%)',
            border: 'none',
            opacity: 0,
            zIndex: 5
          }}
        />
      </div>
    );
  }

  // DYNAMIC CONFIGURATION FOR USER DEFINED BLOCKS
  let cfg;
  if (data.customData && data.customData.content) {
    const variables = data.customData.content?.variables || [];
    const inputs = variables
      .filter(v => v.class === 'Input' || v.class === 'InOut')
      .map(v => ({ name: v.name, type: v.type }));

    const outputs = variables
      .filter(v => v.class === 'Output')
      .map(v => ({ name: v.name, type: v.type }));

    // Add Return Type for Functions
    if (data.customData.returnType) {
      outputs.push({ name: 'OUT', type: data.customData.returnType });
    }

    cfg = {
      label: data.customData.name,
      inputs: inputs,
      outputs: outputs
    };
  } else {
    // Default config for standard blocks
    cfg = blockConfig[data.type] || {
      label: data.type,
      inputs: [{ name: 'IN', type: 'ANY' }, { name: 'IN2', type: 'ANY' }],
      outputs: [{ name: 'OUT', type: 'ANY' }, { name: 'OUT2', type: 'ANY' }]
    };
  }



  // Execution Control (EN) varsa inputlara ekle
  const effectiveInputs = data.executionControl
    ? [{ name: 'EN', type: 'BOOL' }, ...cfg.inputs]
    : cfg.inputs;

  // Execution Control (EN) varsa outputlara ENO ekle
  const effectiveOutputs = data.executionControl
    ? [{ name: 'ENO', type: 'BOOL' }, ...cfg.outputs]
    : cfg.outputs;

  // Instance Name (Header)
  const instanceName = data.instanceName || `${data.type}_1`;

  // Input değeri değiştiğinde
  const handleInputChange = (pinLabel, value) => {
    // 1. React Flow state'ini güncelle (Hızlı UI tepkisi için)
    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id === id) {
          const newData = {
            ...node.data,
            values: {
              ...node.data.values,
              [pinLabel]: value
            }
          };

          // 2. Ana state'i güncelle (Veri kalıcılığı için)
          if (data.onUpdate) {
            data.onUpdate(id, { values: newData.values });
          }

          return {
            ...node,
            data: newData
          };
        }
        return node;
      })
    );
  };

  const isHandleConnected = (handleId, type) => {
    if (type === 'target') {
      return edges.some(e => e.target === id && e.targetHandle === handleId);
    } else {
      return edges.some(e => e.source === id && e.sourceHandle === handleId);
    }
  };

  const isGhost = id === 'ghost-preview';

  return (
    <div style={{
      // Force High Contrast for Debugging transparency issues
      backgroundColor: isGhost ? '#e0e0e0' : (selected ? '#3c3c3c' : '#252526'),
      border: selected ? '2px solid #007acc' : (isGhost ? '2px dashed #007acc' : '1px solid #666'),
      borderRadius: 4,
      minWidth: 140,
      color: isGhost ? '#000' : '#fff', // Black text on white/grey ghost
      fontSize: 11,
      overflow: 'visible',
      boxShadow: selected ? '0 0 8px rgba(0, 122, 204, 0.5)' : '0 2px 4px rgba(0,0,0,0.2)',
      transition: 'all 0.2s ease',
      opacity: isGhost ? 0.9 : 1
    }}>
      <div style={{
        background: isGhost ? '#ccc' : '#333',
        padding: '2px 4px',
        textAlign: 'center',
        fontSize: '10px',
        color: isGhost ? '#000' : '#ccc',
        borderBottom: '1px solid #444',
        borderTopLeftRadius: 3,
        borderTopRightRadius: 3
      }}>
        {instanceName}
      </div>
      <div style={{ background: '#0d47a1', padding: '4px 8px', textAlign: 'center', fontWeight: 'bold' }}>
        {cfg.label}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px' }}>
        {/* INPUTS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {effectiveInputs.map((pin, i) => {
            const handleId = `in_${i}`;
            const connected = isHandleConnected(handleId, 'target');
            const isTime = pin.type === 'TIME';
            const val = data.values?.[pin.name] || '';

            // IEC 61131-3 Time Literal Regex
            // Matches T#..., TIME#... with units d, h, m, s, ms. 
            // Case insensitive.
            const TIME_FORMAT_REGEX = /^(T|TIME)#-?(\d+(\.\d+)?(ms|d|h|m|s)_?)+$/i;
            const TIME_CHAR_REGEX = /^[0-9tihmds._#-]*$/i;

            const isValid = !isTime || !val || TIME_FORMAT_REGEX.test(val);

            return (
              <div key={handleId} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 20 }}>
                {/* External Input Field (Blok dışında, solda) */}
                {!connected && (
                  <input
                    type="text"
                    className="nodrag"
                    value={val}
                    list={pin.type === 'ANY' ? "ladder-vars-ANY" : `ladder-vars-${pin.type}`}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      // Strip emojis coming from autocomplete suggestions (globally and trim)
                      const rawValue = e.target.value;
                      const newValue = rawValue.replace(/[🌍🏠]/g, '').trim();

                      if (isTime && !TIME_CHAR_REGEX.test(newValue)) return;
                      handleInputChange(pin.name, newValue);
                    }}
                    style={{
                      position: 'absolute',
                      right: '100%',
                      marginRight: 15, // Handle (10px) + Gap (5px)
                      width: 40,
                      fontSize: 10,
                      background: '#1e1e1e',
                      border: isValid ? '1px solid #444' : '1px solid #f44336',
                      color: isValid ? '#ddd' : '#f44336',
                      padding: '2px 4px',
                      borderRadius: 2,
                      outline: 'none',
                      textAlign: 'right'
                    }}
                    placeholder={isTime ? 'T#...' : '...'}
                  />
                )}

                {/* External Handle */}
                <Handle
                  type="target"
                  position={Position.Left}
                  id={handleId}
                  isConnectable={true}
                  style={{
                    width: 10,
                    height: 10,
                    background: '#4CAF50',
                    left: -10, // Kutu dışına
                    top: '50%',
                    transform: 'translateY(-50%)',
                    border: '1px solid #fff'
                  }}
                />

                {/* Label (Blok içinde - Tip kaldırıldı) */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginLeft: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 'bold' }}>{pin.name}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* OUTPUTS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end', marginLeft: 10 }}>
          {effectiveOutputs.map((pin, i) => {
            const handleId = `out_${i}`;

            return (
              <div key={handleId} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 20 }}>
                {/* Label (Blok içinde - Tip kaldırıldı) */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1, marginRight: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 'bold' }}>{pin.name}</span>
                </div>

                {/* External Handle */}
                <Handle
                  type="source"
                  position={Position.Right}
                  id={handleId}
                  isConnectable={true}
                  style={{
                    width: 10,
                    height: 10,
                    background: '#FF5722',
                    right: -10, // Kutu dışına
                    top: '50%',
                    transform: 'translateY(-50%)',
                    border: '1px solid #fff'
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div >
  );
};

// Node types defined outside to prevent re-creation on render
const nodeTypes = {
  terminalConnectionPoint: TerminalConnectionPoint,
  blockNode: BlockNode
};

const RungContainer = ({
  rung,
  index,
  totalRungs,
  onDelete,
  onMoveUp,
  onMoveDown,
  onAddBlock,
  onDeleteBlock,
  onAddConnection,
  onDeleteConnection,
  onUpdateBlock,
  onUpdateBlockPosition,

  onNodeDoubleClick,
  availableBlocks = [],
  variables = [],
  globalVars = []
}) => {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(800);
  const [dragGhost, setDragGhost] = useState(null);

  // Container ve Rung boyutları


  // Rung sınırları - containerWidth değişince güncellenir
  const RUNG_BOUNDS = React.useMemo(() => {
    const safeWidth = Math.max(containerWidth, 200);
    return {
      minX: 30,
      maxX: safeWidth - 30,
      height: 150 // Use constant logic
    };
  }, [containerWidth]);

  // Container genişliğini hesapla
  React.useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Constants moved/stabilized
  const LEFT_LINE_X = 12;
  const MIDDLE_Y = 75;
  const RUNG_HEIGHT = 150;

  // Helper to calculate block height
  const getBlockHeight = useCallback((type) => {
    if (type === 'Contact' || type === 'Coil') return 24;
    const config = blockConfig[type];
    if (!config) return 100;
    const rows = Math.max(config.inputs.length, config.outputs.length);
    // Header(~18) + Label(~22) + BodyPadding(16) + Rows*20 + Gaps(10)
    // 56 + rows*20 + (rows-1)*10 -> Simplify: 46 + rows*30
    const calculated = 46 + (rows * 30);
    return Math.min(calculated, RUNG_HEIGHT - 10);
  }, [RUNG_HEIGHT]);

  const createTerminalNodes = useCallback((width) => {
    const safeWidth = Math.max(width, 200);
    // Right Rail Center: width - 10px (margin) - 2px (half line width) = width - 12
    const rightLineX = safeWidth - 12;

    return [
      {
        id: 'terminal_left_middle',
        type: 'terminalConnectionPoint',
        position: { x: LEFT_LINE_X - 10, y: MIDDLE_Y - 10 },
        data: { position: 'left', label: '24V' },
        draggable: false,
        selectable: false,
        zIndex: 100
      },
      {
        id: 'terminal_right_middle',
        type: 'terminalConnectionPoint',
        position: { x: rightLineX - 10, y: MIDDLE_Y - 10 },
        data: { position: 'right', label: '0V' },
        draggable: false,
        selectable: false,
        zIndex: 100
      }
    ];
  }, [LEFT_LINE_X, MIDDLE_Y]);

  const mapBlocksToNodes = useCallback((blocks, width, selectedMap = {}, draggingMap = {}, prevNodes = []) => {
    const safeWidth = Math.max(width, 200);
    const bounds = {
      minX: 50,
      maxX: safeWidth - 50,
      height: RUNG_HEIGHT
    };

    return blocks.map(block => {
      // If node is currently being dragged, preserve its local state completely
      if (draggingMap[block.id]) {
        const prev = prevNodes.find(n => n.id === block.id);
        if (prev) return prev;
      }

      const height = getBlockHeight(block.data.type || block.type);
      return {
        id: block.id,
        type: 'blockNode',
        position: block.position,
        data: {
          ...block.data,
          type: block.data.label || block.type,
          values: block.data.values || {},
          onUpdate: (id, val) => onUpdateBlockRef.current(id, val),
          variables: variables, // Pass to node data
          globalVars: globalVars // Pass to node data
        },
        draggable: true,
        selected: !!selectedMap[block.id],
        extent: [[bounds.minX, 0], [bounds.maxX, RUNG_HEIGHT]] // Fully relaxed Y constraint
      };
    });
  }, [getBlockHeight, variables, globalVars]); // Added variables dependencies

  const [nodes, setNodes, onNodesChange] = useNodesState([
    ...createTerminalNodes(containerWidth),
    ...mapBlocksToNodes(rung.blocks, containerWidth)
  ]);

  // onNodesChange'i sarmalayarak pozisyon kontrolü ekle
  const handleNodesChange = useCallback((changes) => {
    const constrainedChanges = changes.map(change => {
      // Terminal node'ları değiştirme
      if (change.id === 'terminal_left_middle' || change.id === 'terminal_right_middle') {
        return change;
      }
      return change;
    });
    onNodesChange(constrainedChanges);
  }, [onNodesChange]);



  const [edges, setEdges, onEdgesChange] = useEdgesState(
    rung.connections.map(conn => ({
      id: conn.id,
      source: conn.source,
      target: conn.target,
      sourceHandle: conn.sourcePin,
      targetHandle: conn.targetPin,
      type: 'step',
      style: { stroke: '#fff', strokeWidth: 2 },
      animated: false,
    }))
  );

  // Callback ref'i oluştur
  const onUpdateBlockRef = useRef(onUpdateBlock);
  React.useEffect(() => {
    onUpdateBlockRef.current = onUpdateBlock;
  }, [onUpdateBlock]);

  // Rung.blocks değişince nodes'u güncelle
  React.useEffect(() => {


    setNodes((prevNodes) => {
      // Mevcut seçim durumlarını sakla
      const selectedMap = {};
      const draggingMap = {};
      if (prevNodes) {
        prevNodes.forEach(n => {
          if (n.selected) selectedMap[n.id] = true;
          if (n.dragging) draggingMap[n.id] = true;
        });
      }

      return [
        ...createTerminalNodes(containerWidth),
        ...mapBlocksToNodes(rung.blocks, containerWidth, selectedMap, draggingMap, prevNodes)
      ];
    });
  }, [rung.blocks, setNodes, containerWidth, createTerminalNodes, mapBlocksToNodes]);

  // Rung.connections değişince edges'ı güncelle
  React.useEffect(() => {
    setEdges(
      rung.connections.map(conn => ({
        id: conn.id,
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourcePin,
        targetHandle: conn.targetPin,
        type: 'smoothstep',
        style: { stroke: '#fff', strokeWidth: 2 },
        animated: false,
      }))
    );
  }, [rung.connections, setEdges]);

  const { screenToFlowPosition, getNode, setViewport } = useReactFlow();
  const connectionEndPositionRef = useRef(null);

  // Viewport'u sabit tut
  React.useEffect(() => {
    setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
  }, [setViewport]);



  // Çizgilere yakın olup olmadığını kontrol et ve terminal node'a yönlendir
  const checkAndSnapToTerminal = useCallback((connection, endPosition = null) => {
    const safeWidth = Math.max(containerWidth, 200);
    const RIGHT_LINE_X_CALC = safeWidth - 12;
    const SNAP_THRESHOLD = 80;

    let finalConnection = { ...connection };

    // Eğer endPosition varsa (mouse pozisyonu), önce onu kontrol et
    if (endPosition) {
      const { x, y } = endPosition;

      // Sol çizgiye yakın mı kontrol et
      if (Math.abs(x - LEFT_LINE_X) < SNAP_THRESHOLD &&
        Math.abs(y - MIDDLE_Y) < SNAP_THRESHOLD) {
        if (connection.target) {
          finalConnection.target = 'terminal_left_middle';
          finalConnection.targetHandle = 'in';
        }
        if (connection.source) {
          finalConnection.source = 'terminal_left_middle';
          finalConnection.sourceHandle = 'out';
        }
        return finalConnection;
      }
      // Sağ çizgiye yakın mı kontrol et
      else if (Math.abs(x - RIGHT_LINE_X_CALC) < SNAP_THRESHOLD &&
        Math.abs(y - MIDDLE_Y) < SNAP_THRESHOLD) {
        if (connection.target) {
          finalConnection.target = 'terminal_right_middle';
          finalConnection.targetHandle = 'in';
        }
        if (connection.source) {
          finalConnection.source = 'terminal_right_middle';
          finalConnection.sourceHandle = 'out';
        }
        return finalConnection;
      }
    }

    // Mouse pozisyonu yoksa, node pozisyonlarını kontrol et
    const targetNode = connection.target ? getNode(connection.target) : null;
    if (targetNode) {
      const targetX = targetNode.type === 'terminalConnectionPoint' ? targetNode.position.x + 10 : targetNode.position.x;
      const targetY = targetNode.type === 'terminalConnectionPoint' ? targetNode.position.y + 10 : targetNode.position.y;

      if (Math.abs(targetX - LEFT_LINE_X) < SNAP_THRESHOLD &&
        Math.abs(targetY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.target = 'terminal_left_middle';
        finalConnection.targetHandle = 'in';
      }
      else if (Math.abs(targetX - RIGHT_LINE_X_CALC) < SNAP_THRESHOLD &&
        Math.abs(targetY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.target = 'terminal_right_middle';
        finalConnection.targetHandle = 'in';
      }
    }

    const sourceNode = connection.source ? getNode(connection.source) : null;
    if (sourceNode) {
      const sourceX = sourceNode.type === 'terminalConnectionPoint' ? sourceNode.position.x + 10 : sourceNode.position.x;
      const sourceY = sourceNode.type === 'terminalConnectionPoint' ? sourceNode.position.y + 10 : sourceNode.position.y;

      if (Math.abs(sourceX - LEFT_LINE_X) < SNAP_THRESHOLD &&
        Math.abs(sourceY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.source = 'terminal_left_middle';
        finalConnection.sourceHandle = 'out';
      }
      else if (Math.abs(sourceX - RIGHT_LINE_X_CALC) < SNAP_THRESHOLD &&
        Math.abs(sourceY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.source = 'terminal_right_middle';
        finalConnection.sourceHandle = 'out';
      }
    }

    return finalConnection;
  }, [getNode, containerWidth]);

  const onConnectStart = useCallback((event, { nodeId, handleType }) => {
    connectionEndPositionRef.current = null;
    setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
  }, [setViewport]);

  const onConnectEnd = useCallback((event) => {
    if (event && 'clientX' in event && 'clientY' in event) {
      const flowPos = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      });
      connectionEndPositionRef.current = flowPos;
    }
  }, [screenToFlowPosition]);

  const onConnect = useCallback((connection) => {
    const snappedConnection = checkAndSnapToTerminal(connection, connectionEndPositionRef.current);
    connectionEndPositionRef.current = null;

    const edge = {
      source: snappedConnection.source,
      target: snappedConnection.target,
      sourcePin: snappedConnection.sourceHandle,
      targetPin: snappedConnection.targetHandle
    };
    onAddConnection(edge);
    setEdges((eds) => addEdge({
      ...snappedConnection,
      type: 'smoothstep',
      style: { stroke: '#fff', strokeWidth: 2 },
      animated: false,
    }, eds));
  }, [onAddConnection, setEdges, checkAndSnapToTerminal]);

  const onNodesDelete = useCallback((deletedNodes) => {
    deletedNodes.forEach(node => {
      if (node.id !== 'terminal_left_middle' && node.id !== 'terminal_right_middle') {
        onDeleteBlock(node.id);
      }
    });
  }, [onDeleteBlock]);

  const onEdgesDelete = useCallback((deletedEdges) => {
    deletedEdges.forEach(edge => {
      onDeleteConnection(edge.id);
    });
  }, [onDeleteConnection]);

  const onDrop = useCallback((event) => {
    event.preventDefault();

    // Use DragDropManager instead of dataTransfer.getData
    const dragData = DragDropManager.getDragData();
    const blockType = dragData ? dragData.blockType : event.dataTransfer.getData('blockType');

    if (!blockType) return;

    // Use dragData for customData
    const customData = dragData ? dragData.customData : null;
    // (We also keep the old logic as fallback if needed, but manager is primary)

    // clientX, clientY'yi flow coordinate'lerine çevir
    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY
    });

    // Clamp drop position
    const height = getBlockHeight(blockType);

    // Strict Clamping to CURRENT height with Grid Snap Logic [10, 10]
    const maxAllowedY = Math.max(0, RUNG_HEIGHT - height - 5);
    const maxGridY = Math.floor(maxAllowedY / 10) * 10;

    // First calculate Raw Snap, then Clamp
    const rawSnappedY = Math.round(position.y / 10) * 10;
    const constrainedY = Math.max(0, Math.min(maxGridY, rawSnappedY));

    const constrainedX = Math.max(RUNG_BOUNDS.minX, Math.min(RUNG_BOUNDS.maxX, position.x));
    const snappedX = Math.round(constrainedX / 10) * 10;

    const clampedPosition = {
      x: snappedX,
      y: constrainedY
    };

    onAddBlock(blockType, clampedPosition, customData);
    setDragGhost(null);
    DragDropManager.clear();
  }, [screenToFlowPosition, onAddBlock, RUNG_BOUNDS, getBlockHeight]);

  const onDragLeave = useCallback(() => {
    setDragGhost(null);
  }, []);

  const isValidConnection = useCallback((connection) => {
    const sourceNode = getNode(connection.source);
    const targetNode = getNode(connection.target);

    if (!sourceNode || !targetNode) return false;

    // Terminal kontrolü
    const isSourceTerminal = sourceNode.type === 'terminalConnectionPoint';
    const isTargetTerminal = targetNode.type === 'terminalConnectionPoint';

    if (isSourceTerminal && sourceNode.data.position !== 'left') return false; // Right terminal source olamaz
    if (isTargetTerminal && targetNode.data.position !== 'right') return false; // Left terminal target olamaz

    // 2. TYPE CHECK
    const sourceType = isSourceTerminal ? 'BOOL' : (() => {
      if (!connection.sourceHandle) return 'ANY';
      const pinIndex = parseInt(connection.sourceHandle.split('_')[1]);

      // Dynamic output adjustment for ENO
      if (sourceNode.data.executionControl) {
        if (pinIndex === 0) return 'BOOL'; // ENO pin
        const config = blockConfig[sourceNode.data.type];
        return config?.outputs[pinIndex - 1]?.type || 'ANY';
      }

      const config = blockConfig[sourceNode.data.type];
      return config?.outputs[pinIndex]?.type || 'ANY';
    })();

    const targetType = isTargetTerminal ? 'BOOL' : (() => {
      if (!connection.targetHandle) return 'ANY';
      const pinIndex = parseInt(connection.targetHandle.split('_')[1]);

      // Dynamic input adjustment for EN
      if (targetNode.data.executionControl) {
        if (pinIndex === 0) return 'BOOL'; // EN pin
        const config = blockConfig[targetNode.data.type];
        return config?.inputs[pinIndex - 1]?.type || 'ANY';
      }

      const config = blockConfig[targetNode.data.type];
      return config?.inputs[pinIndex]?.type || 'ANY';
    })();

    if (sourceType !== targetType && sourceType !== 'ANY' && targetType !== 'ANY') {
      console.warn(`Type Mismatch: ${sourceType} -> ${targetType}`);
      return false;
    }

    return true;
  }, [getNode, blockConfig]);

  // Throttled Drag Handler (24 FPS ~= 40ms)
  const lastDragTimeRef = useRef(0);

  const throttleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    // FPS LIMIT CHECK
    const now = Date.now();
    if (now - lastDragTimeRef.current < 40) {
      return;
    }
    lastDragTimeRef.current = now;

    // Retrieve FROM DragDropManager
    const dragData = DragDropManager.getDragData();
    // logDebug(`DragOver: ${JSON.stringify(dragData)}`); // Performance optimization

    if (!dragData) {
      if (dragGhost) setDragGhost(null);
      return;
    }

    const { blockType, customData } = dragData;

    // Calculate Position
    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY
    });
    // logDebug(`Pos: ${JSON.stringify(position)}`); 

    const height = getBlockHeight(blockType || 'Contact'); // default safe

    // Grid Snap Logic [10, 10]
    const rawX = Math.max(RUNG_BOUNDS.minX, Math.min(RUNG_BOUNDS.maxX, position.x));

    // CLAMP Y to FIXED RUNG HEIGHT
    const maxAllowedY = Math.max(0, RUNG_HEIGHT - height - 5);
    const maxGridY = Math.floor(maxAllowedY / 10) * 10;

    // First calculate Raw Snap, then Clamp
    const rawSnappedY = Math.round(position.y / 10) * 10;
    const constrainedY = Math.max(0, Math.min(maxGridY, rawSnappedY));

    const snappedX = Math.round(rawX / 10) * 10;

    const clampedPosition = {
      x: snappedX,
      y: constrainedY
    };

    // logDebug(`GhostPos: ${JSON.stringify(clampedPosition)}`);

    // Optimization: Only update if position changed significantly
    if (dragGhost &&
      dragGhost.position.x === clampedPosition.x &&
      dragGhost.position.y === clampedPosition.y) {
      return;
    }

    setDragGhost({
      id: 'ghost-preview',
      type: 'blockNode',
      position: clampedPosition,
      data: {
        type: blockType,
        label: blockType,
        customData: customData, // Pass only if necessary
        executionControl: false
      },
      style: {
        opacity: 0.9,
        pointerEvents: 'none',
        zIndex: 99999,
        filter: 'brightness(1.5)',
        // Restore explicit dimensions to ensure visibility
        width: blockType === 'Contact' || blockType === 'Coil' ? 40 : 140,
        height: height
      },
      zIndex: 99999,
      draggable: false,
      selectable: false
    });
  }, [screenToFlowPosition, RUNG_BOUNDS, getBlockHeight, RUNG_HEIGHT, dragGhost, setDragGhost, logDebug]);

  const onNodeDragStop = useCallback((event, node) => {
    // Blok pozisyonu değişince ana state'i güncelle
    if (node.id === 'terminal_left_middle' || node.id === 'terminal_right_middle') return;

    // Position değişmişse güncelle
    onUpdateBlockPosition(node.id, node.position);
  }, [onUpdateBlockPosition]);

  return (
    <div style={{
      background: '#2a2a2a',
      border: '2px solid #444',
      borderRadius: 8,
      overflow: 'hidden',
      boxShadow: '0 4px 6px rgba(0,0,0,0.3)'
    }}>
      {/* RUNG HEADER */}
      <div style={{
        background: '#252526',
        padding: '10px 15px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid #444'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <span style={{ color: '#fff', fontWeight: 'bold', fontSize: 14 }}>
            Rung {index}: {rung.label}
          </span>
          <span style={{ color: '#888', fontSize: 11 }}>
            ({rung.blocks.length} blok)
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onMoveUp}
            disabled={index === 0}
            style={{
              background: index === 0 ? '#444' : '#0d47a1',
              color: '#fff',
              border: 'none',
              padding: '5px 10px',
              borderRadius: 3,
              cursor: index === 0 ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 'bold'
            }}
          >
            ↑ Yukarı
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === totalRungs - 1}
            style={{
              background: index === totalRungs - 1 ? '#444' : '#0d47a1',
              color: '#fff',
              border: 'none',
              padding: '5px 10px',
              borderRadius: 3,
              cursor: index === totalRungs - 1 ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 'bold'
            }}
          >
            ↓ Aşağı
          </button>
          <button
            onClick={onDelete}
            style={{
              background: '#c62828',
              color: '#fff',
              border: 'none',
              padding: '5px 10px',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 'bold'
            }}
          >
            🗑 Sil
          </button>
        </div>
      </div>

      {/* RUNG EDITOR CANVAS */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: RUNG_HEIGHT,
          background: '#1e1e1e',
          position: 'relative',
          border: '1px dashed #444',
          overflow: 'hidden'
        }}
      // Handlers moved back to ReactFlow for better integration
      >
        {/* Terminal Çizgileri Arka Planda */}
        <div style={{
          position: 'absolute',
          left: 10,
          top: 0,
          bottom: 0,
          width: 4,
          background: '#ff3333',
          pointerEvents: 'none',
          zIndex: 0
        }} />

        <div style={{
          position: 'absolute',
          right: 10,
          top: 0,
          bottom: 0,
          width: 4,
          background: '#0066ff',
          pointerEvents: 'none',
          zIndex: 0
        }} />

        <ReactFlow
          style={{ zIndex: 5 }}
          nodes={dragGhost ? [...nodes, dragGhost] : nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          isValidConnection={isValidConnection}
          onDrop={onDrop}
          onDragOver={throttleDragOver}
          onDragLeave={(e) => {
            // Fix: Only clear ghost if we genuinely leave the container
            // (e.relatedTarget is the element we are entering)
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setDragGhost(null);
            }
          }}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={onNodeDoubleClick}
          snapToGrid={true}
          snapGrid={[10, 10]}
          minZoom={1}
          maxZoom={1}
          fitView={false}
          attributionPosition="top-left"
          proOptions={{ hideAttribution: true }}
          selectionOnDrag={false}
          panOnDrag={false}
          panOnScroll={false}
          panOnConnect={false}
          autoPanOnConnect={false}
          autoPanOnNodeDrag={false}
          preventScrolling={false}
          zoomOnScroll={false}
          edgesUpdatable={true}
          edgesFocusable={true}
          edgesSelectable={true}
          nodesDraggable={true}
          nodesConnectable={true}
          nodesSelectable={true}
          deleteKeyCode={['Backspace', 'Delete']}
          multiSelectionKeyCode={['Meta', 'Ctrl']}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        />
      </div>
    </div>
  );
};

// Wrapper with ReactFlowProvider
const RungContainerWrapper = (props) => (
  <ReactFlowProvider>
    <RungContainer {...props} />
  </ReactFlowProvider>
);

export default RungContainerWrapper;
