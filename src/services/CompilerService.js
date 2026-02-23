// CompilerService.js

export const compileProjectToST = (projectStructure) => {
    let fullST = "";

    // Helper to format variables
    const formatVars = (variables) => {
        if (!variables || variables.length === 0) return "";
        let varBlock = "  VAR\n";
        variables.forEach(v => {
            const init = v.initialValue ? ` := ${v.initialValue}` : "";
            varBlock += `    ${v.name} : ${v.type}${init};\n`;
        });
        varBlock += "  END_VAR\n";
        return varBlock;
    };

    // 1. Types / Global Vars (Future Implementation)
    // ...

    // 2. Functions & Function Blocks
    // TODO: Add support for compiling FBs and Functions once we have ST representation for them

    // 3. Programs
    if (projectStructure.programs) {
        projectStructure.programs.forEach(prog => {
            fullST += `PROGRAM ${prog.name}\n`;

            // Variables
            if (prog.content && prog.content.variables) {
                fullST += formatVars(prog.content.variables);
            }

            // Code Body
            fullST += "  // Code Body\n";
            if (prog.type === 'ST' && prog.content && prog.content.code) {
                fullST += prog.content.code + "\n";
            } else if (prog.type === 'LD') {
                fullST += "  // Ladder Logic compilation not yet implemented\n";
            }

            fullST += "END_PROGRAM\n\n";
        });
    }

    return fullST;
};
