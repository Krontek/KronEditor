import React, { useState, useEffect } from 'react';
import VariableManager from './VariableManager';
import TaskEditor from './TaskEditor';
import InstanceEditor from './InstanceEditor';
import { useTranslation } from 'react-i18next';

const ResourceEditor = ({ content, onContentChange, availablePrograms }) => {
    const { t } = useTranslation();

    // Layout State (Flex Ratios)
    // Initial: 1, 1, 1 (Equal height)
    const [flexRatios, setFlexRatios] = useState({
        globals: 1,
        tasks: 1,
        instances: 1
    });
    const containerRef = React.useRef(null);
    const [isResizing, setIsResizing] = useState(null); // 'globals-tasks' or 'tasks-instances'

    // --- Resize Logic ---
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isResizing || !containerRef.current) return;

            const containerHeight = containerRef.current.clientHeight;
            if (containerHeight === 0) return;

            // Calculate movement as percentage of container
            // Total Flex Sum is roughly 3 (1+1+1) but varies.
            const totalFlex = flexRatios.globals + flexRatios.tasks + flexRatios.instances;

            // Delta Flex = (MovementY / ContainerHeight) * TotalFlex
            const deltaFlex = (e.movementY / containerHeight) * totalFlex;

            setFlexRatios(prev => {
                const newRatios = { ...prev };
                const MIN_FLEX = 0.2; // Minimum size constraint

                if (isResizing === 'globals-tasks') {
                    // Resize border between Globals and Tasks
                    // Globals grows/shrinks, Tasks shrinks/grows
                    const newGlobals = Math.max(MIN_FLEX, prev.globals + deltaFlex);
                    const newTasks = Math.max(MIN_FLEX, prev.tasks - (newGlobals - prev.globals)); // conserve total

                    newRatios.globals = newGlobals;
                    newRatios.tasks = newTasks;
                } else if (isResizing === 'tasks-instances') {
                    // Resize border between Tasks and Instances
                    const newTasks = Math.max(MIN_FLEX, prev.tasks + deltaFlex);
                    const newInstances = Math.max(MIN_FLEX, prev.instances - (newTasks - prev.tasks));

                    newRatios.tasks = newTasks;
                    newRatios.instances = newInstances;
                }

                return newRatios;
            });
        };

        const handleMouseUp = () => {
            setIsResizing(null);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto'; // Re-enable selection
        };

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none'; // Disable text selection while dragging
        } else {
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };
    }, [isResizing, flexRatios]);

    // --- Handlers ---

    // 1. Global Variables
    const handleAddVar = (newVar) => {
        // VariableManager usually passes a new object or we create it?
        // Let's check standard VariableManager. It usually calls onAdd(newVar) or onAdd().
        // If it sends onAdd(newVar), we use it. If onAdd(), we create it.
        // Code snippet in VariableManager verifies it calls onAdd(defaultVar) ? No, checked lines 80-100, didn't see calls.

        // Assuming generic variable creation:
        const variable = newVar || {
            id: Date.now().toString(),
            name: 'NewVar',
            class: 'Var',
            type: 'BOOL',
            location: '',
            initialValue: '',
            desc: ''
        };
        const newVars = [...(content.globalVars || []), variable];
        onContentChange({ ...content, globalVars: newVars });
    };

    const handleUpdateVar = (id, field, value) => {
        const newVars = (content.globalVars || []).map(v =>
            v.id === id ? { ...v, [field]: value } : v
        );
        onContentChange({ ...content, globalVars: newVars });
    };

    const handleDeleteVar = (id) => {
        const newVars = (content.globalVars || []).filter(v => v.id !== id);
        onContentChange({ ...content, globalVars: newVars });
    };

    // 2. Tasks
    const handleAddTask = (newTask) => {
        const task = newTask || {
            id: `task_${Date.now()}`,
            name: 'NewTask',
            triggering: 'Cyclic',
            interval: 'T#20ms',
            priority: 1
        };
        const newTasks = [...(content.tasks || []), task];
        onContentChange({ ...content, tasks: newTasks });
    };

    const handleUpdateTask = (id, field, value) => {
        const newTasks = (content.tasks || []).map(t =>
            t.id === id ? { ...t, [field]: value } : t
        );
        onContentChange({ ...content, tasks: newTasks });
    };

    const handleDeleteTask = (id) => {
        // Also remove instances causing cascading delete? Or just leave them?
        // Ideally warn, but for now just delete task.
        const newTasks = (content.tasks || []).filter(t => t.id !== id);
        onContentChange({ ...content, tasks: newTasks });
    };

    // 3. Instances
    const handleAddInstance = (newInstance) => {
        const instance = newInstance || {
            id: `inst_${Date.now()}`,
            name: 'Instance',
            program: '',
            task: ''
        };
        const newInsts = [...(content.instances || []), instance];
        onContentChange({ ...content, instances: newInsts });
    };

    const handleUpdateInstance = (id, field, value) => {
        const newInsts = (content.instances || []).map(i =>
            i.id === id ? { ...i, [field]: value } : i
        );
        onContentChange({ ...content, instances: newInsts });
    };

    const handleDeleteInstance = (id) => {
        const newInsts = (content.instances || []).filter(i => i.id !== id);
        onContentChange({ ...content, instances: newInsts });
    };


    const SectionHeader = ({ title }) => (
        <div style={{
            padding: '5px 10px', background: '#2d2d2d', color: '#ccc', fontSize: '11px',
            fontWeight: 'bold', textTransform: 'uppercase', borderBottom: '1px solid #333'
        }}>
            {title}
        </div>
    );

    const Resizer = ({ target }) => (
        <div
            onMouseDown={() => setIsResizing(target)}
            style={{
                height: '5px', background: isResizing === target ? '#007acc' : '#1e1e1e',
                cursor: 'row-resize', borderTop: '1px solid #333', borderBottom: '1px solid #333',
                flexShrink: 0
            }}
        />
    );

    return (
        <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

            {/* 1. Global Variables */}
            <div style={{ flex: flexRatios.globals, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <SectionHeader title={t('resources.globalVariables')} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <VariableManager
                        variables={content.globalVars || []}
                        onDelete={handleDeleteVar}
                        onUpdate={handleUpdateVar}
                        onAdd={handleAddVar}
                        allowedClasses={['Var', 'Constant', 'Retain']}
                    />
                </div>
            </div>

            <Resizer target="globals-tasks" />

            {/* 2. Tasks */}
            <div style={{ flex: flexRatios.tasks, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <SectionHeader title={t('resources.taskConfiguration')} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <TaskEditor
                        tasks={content.tasks || []}
                        onUpdate={handleUpdateTask}
                        onDelete={handleDeleteTask}
                        onAdd={handleAddTask}
                    />
                </div>
            </div>

            <Resizer target="tasks-instances" />

            {/* 3. Instances */}
            <div style={{ flex: flexRatios.instances, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <SectionHeader title={t('resources.programInstances')} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <InstanceEditor
                        instances={content.instances || []}
                        programs={availablePrograms}
                        tasks={content.tasks?.map(t => t.name) || []}
                        onUpdate={handleUpdateInstance}
                        onDelete={handleDeleteInstance}
                        onAdd={handleAddInstance}
                    />
                </div>
            </div>

        </div>
    );
};

export default ResourceEditor;
