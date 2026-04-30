
async function checkHash() {
    const hash = '0xd643594acfcdee84029808620beeb07ce24000f1ee9344ae8664a80639cb0e27';
    const trade = db.useractivities.findOne({ transactionHash: hash });
    console.log("Trade found for hash:", trade ? "YES" : "NO");
    
    // Check if there are ANY trades for the trader starkmkt
    const trader = '0xb54101496b7078873447869c1804b2f85a3d1852';
    const count = db.useractivities.countDocuments({ traderAddress: trader });
    console.log("Total trades for trader:", count);
}
checkHash();
