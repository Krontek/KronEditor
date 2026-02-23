// Simple singleton to hold drag data accessible during dragOver (where dataTransfer is protected)
const DragDropManager = {
    currentDragData: null,

    setDragData: (data) => {
        DragDropManager.currentDragData = data;
    },

    getDragData: () => {
        return DragDropManager.currentDragData;
    },

    clear: () => {
        DragDropManager.currentDragData = null;
    }
};

export default DragDropManager;
