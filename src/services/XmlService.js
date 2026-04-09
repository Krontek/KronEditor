/**
 * XmlService.js
 * Handles conversion between Project Structure and XML.
 * Uses CDATA sections to store complex React Flow / Editor content to ensure exact restoration.
 */

export const exportProjectToXml = (projectStructure, boardId, connectionSettings = {}, buses = [], busConfigs = {}, watchTable = [], hmiLayout = null) => {
    const doc = document.implementation.createDocument(null, "PLCProject", null);
    const root = doc.documentElement;

    if (boardId) {
        root.setAttribute("board", boardId);
    }
    if (connectionSettings.plcAddress) {
        root.setAttribute("plcAddress", connectionSettings.plcAddress);
    }
    if (connectionSettings.sshUser) {
        root.setAttribute("sshUser", connectionSettings.sshUser);
    }
    if (connectionSettings.sshPort) {
        root.setAttribute("sshPort", connectionSettings.sshPort);
    }
    if (connectionSettings.apiPassword) {
        root.setAttribute("apiPassword", connectionSettings.apiPassword);
    }
    if (connectionSettings.autoRun) {
        root.setAttribute("autoRun", "true");
    }

    const createSection = (name, items) => {
        const section = doc.createElement(name);
        items.forEach(item => {
            const itemNode = doc.createElement("Item");
            itemNode.setAttribute("id", item.id);
            itemNode.setAttribute("name", item.name);
            itemNode.setAttribute("type", item.type || "");
            if (item.returnType) itemNode.setAttribute("returnType", item.returnType);

            // Store complex content as JSON in CDATA
            const contentNode = doc.createElement("Content");
            const cdata = doc.createCDATASection(JSON.stringify(item.content));
            contentNode.appendChild(cdata);
            itemNode.appendChild(contentNode);

            section.appendChild(itemNode);
        });
        root.appendChild(section);
    };

    createSection("DataTypes", projectStructure.dataTypes);
    createSection("FunctionBlocks", projectStructure.functionBlocks);
    createSection("Functions", projectStructure.functions);
    createSection("Programs", projectStructure.programs);
    createSection("Resources", projectStructure.resources);

    // TaskConfig: stored as JSON CDATA
    if (projectStructure.taskConfig) {
        const tcSection = doc.createElement("TaskConfig");
        tcSection.appendChild(doc.createCDATASection(JSON.stringify(projectStructure.taskConfig)));
        root.appendChild(tcSection);
    }

    // WatchTable: persisted as JSON CDATA
    if (watchTable && watchTable.length > 0) {
        const wtSection = doc.createElement("WatchTable");
        wtSection.appendChild(doc.createCDATASection(JSON.stringify(watchTable)));
        root.appendChild(wtSection);
    }

    // Fieldbus: buses array + busConfigs map stored as JSON CDATA
    if (buses.length > 0) {
        const fieldbusSection = doc.createElement("Fieldbus");
        const cdata = doc.createCDATASection(JSON.stringify({ buses, busConfigs }));
        fieldbusSection.appendChild(cdata);
        root.appendChild(fieldbusSection);
    }

    // HmiLayout: visualization pages stored as JSON CDATA
    if (hmiLayout && hmiLayout.pages && hmiLayout.pages.length > 0) {
        const hmiSection = doc.createElement("HmiLayout");
        hmiSection.appendChild(doc.createCDATASection(JSON.stringify(hmiLayout)));
        root.appendChild(hmiSection);
    }

    const serializer = new XMLSerializer();
    return serializer.serializeToString(doc);
};

export const importProjectFromXml = (xmlString) => {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, "application/xml");

        // Check for parser errors
        const parserError = doc.getElementsByTagName("parsererror");
        if (parserError.length > 0) {
            console.error("XML Parsing Error:", parserError[0].textContent);
            return null;
        }

        const projectStructure = {
            dataTypes: [],
            functionBlocks: [],
            functions: [],
            programs: [],
            resources: []
        };

        const boardId = doc.documentElement.getAttribute("board") || null;
        const plcAddress = doc.documentElement.getAttribute("plcAddress") || null;
        const sshUser = doc.documentElement.getAttribute("sshUser") || null;
        const sshPort = doc.documentElement.getAttribute("sshPort") || null;
        const apiPassword = doc.documentElement.getAttribute("apiPassword") || null;
        const autoRun = doc.documentElement.getAttribute("autoRun") === "true";

        const parseSection = (sectionName, key) => {
            const section = doc.getElementsByTagName(sectionName)[0];
            if (!section) return;

            const items = section.getElementsByTagName("Item");
            for (let i = 0; i < items.length; i++) {
                const itemNode = items[i];
                const id = itemNode.getAttribute("id");
                const name = itemNode.getAttribute("name");
                const type = itemNode.getAttribute("type");
                const returnType = itemNode.getAttribute("returnType");

                const contentNode = itemNode.getElementsByTagName("Content")[0];
                let content = {};
                // CDATA content is in textContent
                if (contentNode && contentNode.textContent) {
                    try {
                        content = JSON.parse(contentNode.textContent);
                    } catch (e) {
                        console.error(`Failed to parse content for ${name}`, e);
                    }
                }

                projectStructure[key].push({
                    id,
                    name,
                    type: type || undefined,
                    returnType: returnType || undefined,
                    content
                });
            }
        };

        parseSection("DataTypes", "dataTypes");
        parseSection("FunctionBlocks", "functionBlocks");
        parseSection("Functions", "functions");
        parseSection("Programs", "programs");
        parseSection("Resources", "resources");

        // Fieldbus
        let buses = [];
        let busConfigs = {};
        const fieldbusSection = doc.getElementsByTagName("Fieldbus")[0];
        if (fieldbusSection && fieldbusSection.textContent) {
            try {
                const fb = JSON.parse(fieldbusSection.textContent);
                buses = fb.buses || [];
                busConfigs = fb.busConfigs || {};
            } catch (e) {
                console.error("Failed to parse Fieldbus section", e);
            }
        }

        // TaskConfig
        let taskConfig = { tasks: [] };
        const tcSection = doc.getElementsByTagName("TaskConfig")[0];
        if (tcSection && tcSection.textContent) {
            try {
                taskConfig = JSON.parse(tcSection.textContent);
            } catch (e) {
                console.error("Failed to parse TaskConfig section", e);
            }
        }
        projectStructure.taskConfig = taskConfig;

        // WatchTable
        let watchTable = [];
        const wtSection = doc.getElementsByTagName("WatchTable")[0];
        if (wtSection && wtSection.textContent) {
            try { watchTable = JSON.parse(wtSection.textContent); } catch (e) { /* ignore */ }
        }

        // HmiLayout
        let hmiLayout = null;
        const hmiSection = doc.getElementsByTagName("HmiLayout")[0];
        if (hmiSection && hmiSection.textContent) {
            try { hmiLayout = JSON.parse(hmiSection.textContent); } catch (e) { /* ignore */ }
        }

        return { projectStructure, boardId, plcAddress, sshUser, sshPort, apiPassword, autoRun, buses, busConfigs, watchTable, hmiLayout };
    } catch (e) {
        console.error("Critical Import Error:", e);
        return null;
    }
};
