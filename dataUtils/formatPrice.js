
export const formatPrice = (price, step) => {
    if (!price || !step || Number(step) <= 0) {
        return '0';
    }
    
    const priceNum = Number(price);
    const stepNum = Number(step);
    
    if (priceNum <= 0) {
        return '0';
    }
    
    // 计算价格精度（小数位数）
    const stepStr = stepNum.toString();
    const decimalIndex = stepStr.indexOf('.');
    const precision = decimalIndex >= 0 ? stepStr.length - decimalIndex - 1 : 0;
    
    // 计算调整后的价格
    const adjustedPrice = Math.round(priceNum / stepNum) * stepNum;
    
    // 格式化为指定精度的字符串
    return adjustedPrice.toFixed(precision);
}
