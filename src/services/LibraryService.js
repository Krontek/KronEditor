
export class LibraryService {
    constructor() {
        this.library = [];
        // List of library files to load
        this.libraryFiles = [
            '/libraries/timers.xml',
            '/libraries/counters.xml',
            '/libraries/bit_logic.xml'
        ];
    }

    async loadLibrary() {
        try {
            // 1. Fetch ALL files concurrently
            const promises = this.libraryFiles.map(file =>
                fetch(file)
                    .then(res => {
                        if (!res.ok) throw new Error(`Failed to load ${file}`);
                        return res.text();
                    })
                    .then(text => this.parseXml(text)) // Parse each
                    .catch(err => {
                        console.warn(`Error loading library file ${file}:`, err);
                        return []; // Return empty array on failure to keep others
                    })
            );

            const results = await Promise.all(promises);

            // 2. Aggregate Results (Flatten array of arrays)
            // results is [[Category1...], [Category2...], ...]
            const aggregatedLibrary = results.flat();

            this.library = aggregatedLibrary;
            return this.library;

        } catch (error) {
            console.error("Critical error loading libraries:", error);
            return [];
        }
    }

    parseXml(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const libraryPart = [];

        const categories = xmlDoc.getElementsByTagName("Category");
        for (let i = 0; i < categories.length; i++) {
            const categoryNode = categories[i];
            const categoryName = categoryNode.getAttribute("name");
            const blocks = [];

            const blockNodes = categoryNode.getElementsByTagName("Block");
            for (let j = 0; j < blockNodes.length; j++) {
                const blockNode = blockNodes[j];
                const type = blockNode.getAttribute("type");
                const description = blockNode.getAttribute("description");
                const blockClass = blockNode.getAttribute("class"); // FunctionBlock or Function

                const inputs = [];
                const inputNodes = blockNode.querySelector("Inputs")?.getElementsByTagName("Variable") || [];
                for (let k = 0; k < inputNodes.length; k++) {
                    inputs.push({
                        name: inputNodes[k].getAttribute("name"),
                        type: inputNodes[k].getAttribute("type"),
                        default: inputNodes[k].getAttribute("default")
                    });
                }

                const outputs = [];
                const outputNodes = blockNode.querySelector("Outputs")?.getElementsByTagName("Variable") || [];
                for (let k = 0; k < outputNodes.length; k++) {
                    outputs.push({
                        name: outputNodes[k].getAttribute("name"),
                        type: outputNodes[k].getAttribute("type")
                    });
                }

                blocks.push({
                    blockType: type,
                    label: type,
                    desc: description,
                    class: blockClass,
                    inputs,
                    outputs
                });
            }

            libraryPart.push({
                id: categoryName.toLowerCase(),
                title: categoryName.replace('_', ' '),
                blocks
            });
        }

        return libraryPart;
    }

    getBlock(blockType) {
        for (const cat of this.library) {
            const block = cat.blocks.find(b => b.blockType === blockType);
            if (block) return block;
        }
        return null;
    }
}

export const libraryService = new LibraryService();
