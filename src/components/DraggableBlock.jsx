import React from 'react';

const DraggableBlock = ({ type, label, icon }) => {
    const onDragStart = (event, nodeType) => {
        event.dataTransfer.setData('application/reactflow', nodeType);
        event.dataTransfer.setData('blockType', nodeType);
        event.dataTransfer.effectAllowed = 'move';
    };

    return (
        <div
            onDragStart={(event) => onDragStart(event, type)}
            draggable
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                width: '60px',
                height: '50px',
                border: '1px solid #444',
                borderRadius: '4px',
                background: '#333',
                cursor: 'grab',
                color: '#fff',
                fontSize: '10px',
                gap: '4px'
            }}
            title={`Drag ${label} to a rung`}
        >
            {icon}
            <span>{label}</span>
        </div>
    );
};

export default DraggableBlock;
