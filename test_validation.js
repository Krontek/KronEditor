const variables = [{name: 'Var0'}, {name: 'Var1'}, {name: 'Var2'}];
const globalVars = [];

const instanceNames = ['Var2', 'Var2[0]', 'Var2.member'];

instanceNames.forEach(instanceName => {
    const rawVal = instanceName.replace(/[🌍🏠⊞⊡⊟]/g, '').trim().split(/[\[.]/)[0];
    const present = [...variables, ...globalVars].some(v => v.name === rawVal);
    console.log(`Original: ${instanceName}, Raw: ${rawVal}, Present: ${present}`);
});
