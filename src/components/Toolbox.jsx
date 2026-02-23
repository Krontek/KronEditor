import React, { useState, useEffect } from 'react';
import { PLC_BLOCKS } from '../utils/plcStandards';
import DragDropManager from '../utils/DragDropManager';

// Helper: Generate ST Snippet for Ghost (and Drop Data)
const generateSTSnippet = (blockType, customData) => {
  // 1. Function Block (Standard or User Defined)
  if (customData) {
    const inputs = customData.inputs || [];
    const instanceName = `${blockType}0`;
    // Treat as FunctionBlock unless explicitly a function with return type
    if (customData.type === 'functionBlocks' || customData.class === 'FunctionBlock' || !customData.returnType) {
      const params = inputs.map(input => `  ${input.name} := ${input.default || ''},`).join('\n');
      return `${instanceName}(\n${params}\n);`;
    }
  }

  // 2. Standard Blocks (from standard lib if not in customData)
  const blockConfig = PLC_BLOCKS[blockType];
  if (blockConfig) {
    const inputs = blockConfig.inputs || [];
    const instanceName = `${blockType}0`;
    const params = inputs.map(input => `  ${input.name} := ...`).join(',\n');
    return `${instanceName}(\n${params}\n);`;
  }

  // 3. Functions or Simple Types
  return `${blockType}(...);`;
};

// Helper: Pre-load Invisible Image
const EMPTY_IMG = new Image();
EMPTY_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const ToolboxItem = ({ type, blockType, label, desc, color, customData, isST }) => {
  const onDragStart = (event) => {
    const nodeType = type === 'default' ? 'blockNode' : type;
    event.dataTransfer.setData('application/reactflow', nodeType);
    if (blockType) event.dataTransfer.setData('blockType', blockType);
    event.dataTransfer.setData('label', label);
    if (customData) event.dataTransfer.setData('customData', JSON.stringify(customData));

    // 'copyMove' allows both drop effects
    event.dataTransfer.effectAllowed = 'copyMove';

    // Helper to check standard blocks quickly if not in customData
    const isStandard = !!PLC_BLOCKS[blockType];

    // Generate Snippet and attach to dataTransfer for ST Preview in EditorPane
    let stSnippet = null;
    if (blockType && !label.startsWith('Contact') && !label.startsWith('Coil')) {
      const data = customData || (isStandard ? {} : null);
      if (data) {
        stSnippet = generateSTSnippet(blockType, data);
        event.dataTransfer.setData('stSnippet', stSnippet);
      }
    }

    // Set Global Drag Data for in-app Previews (bypasses DragOver security restrictions)
    DragDropManager.setDragData({
      type: nodeType,
      blockType: blockType,
      label: label,
      customData: customData, // Pass full object
      stSnippet: stSnippet
    });

    // Use Invisible Ghost so user only sees the In-Place Preview
    if (event.dataTransfer.setDragImage) {
      event.dataTransfer.setDragImage(EMPTY_IMG, 0, 0);
    }
  };

  const onDragEnd = () => {
    DragDropManager.clear();
  };

  return (
    <div
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      draggable
      style={{
        padding: '8px 12px',
        margin: '5px 0 5px 10px',
        background: color,
        color: '#fff',
        borderRadius: '4px',
        cursor: 'grab',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid rgba(255,255,255,0.1)'
      }}
    >
      <span style={{ fontWeight: 'bold', fontSize: '13px' }}>{label}</span>
      {desc && <span style={{ fontSize: '10px', opacity: 0.8 }}>{desc}</span>}
    </div>
  );
};

const Toolbox = ({ userDefinedBlocks = [], libraryData = [], activeFileType }) => {
  const fbColor = '#673ab7';
  const udColor = '#007acc';
  const isST = activeFileType === 'ST';

  let combinedCategories = libraryData.length > 0 ? [...libraryData] : [];

  if (combinedCategories.length === 0) {
    combinedCategories = [
      { id: 'loading', title: 'LOADING LIBRARY...', blocks: [] }
    ];
  }

  if (userDefinedBlocks && userDefinedBlocks.length > 0) {
    combinedCategories.push({
      id: 'user_defined',
      title: 'USER DEFINED',
      blocks: userDefinedBlocks.map(b => ({
        type: 'default',
        blockType: b.name,
        label: b.name,
        desc: b.type === 'functionBlocks' ? 'Block' : 'Func', // Short desc
        customData: { ...b }
      }))
    });
  }

  const [expanded, setExpanded] = useState({});

  // No auto-expand

  const toggleCategory = (id) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div style={{ padding: '0 15px', height: '100%', overflowY: 'auto' }}>
      {combinedCategories.map(category => (
        <div key={category.id} style={{ marginBottom: 10 }}>
          <div
            onClick={() => toggleCategory(category.id)}
            style={{
              padding: '10px 0',
              color: '#ddd',
              fontSize: '11px',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              borderBottom: '1px solid #3e3e42',
              marginBottom: '5px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              userSelect: 'none'
            }}
          >
            <span style={{ marginRight: 5, fontSize: 10 }}>
              {expanded[category.id] ? '▼' : '▶'}
            </span>
            {category.title}
          </div>

          {expanded[category.id] && (
            <div>
              {category.blocks.map((block, index) => (
                <ToolboxItem
                  key={index}
                  type={block.type || 'default'}
                  blockType={block.blockType}
                  label={block.label}
                  desc={block.desc}
                  customData={block.customData}
                  color={category.id === 'user_defined' ? udColor : fbColor}
                  isST={isST}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default Toolbox;