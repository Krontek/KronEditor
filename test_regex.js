const testNames = [" Var2", "Var2 ", "Var2[1]", "🌍 Var2", "🏠 Var2", "Var2.member", "  Var2  "];

testNames.forEach(n => {
    const parsed = n.replace(/[🌍🏠⊞⊡⊟]/g, '').trim().split(/[\[.]/)[0];
    console.log(`'${n}' -> '${parsed}'`);
});
