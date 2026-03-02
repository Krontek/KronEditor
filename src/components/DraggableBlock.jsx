import React from 'react';

const DraggableBlock = ({ type, label, icon }) => {
    const onDragStart = (event, nodeType) => {
        event.dataTransfer.setData('application/reactflow', nodeType);
        event.dataTransfer.setData('blockType', nodeType);
        event.dataTransfer.effectAllowed = 'move';

        // Add a smaller, proportionally accurate drag ghost
        const ghostContainer = document.createElement("div");
        ghostContainer.style.width = "18px";
        ghostContainer.style.height = "18px";
        ghostContainer.style.border = "2px solid #007acc";
        ghostContainer.style.background = "rgba(255, 255, 255, 0.1)";
        ghostContainer.style.position = "absolute";
        ghostContainer.style.top = "-1000px";
        document.body.appendChild(ghostContainer);
        event.dataTransfer.setDragImage(ghostContainer, 9, 9);

        // Cleanup function for ghost element after a slight delay
        setTimeout(() => {
            if (document.body.contains(ghostContainer)) {
                document.body.removeChild(ghostContainer);
            }
        }, 100);
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
