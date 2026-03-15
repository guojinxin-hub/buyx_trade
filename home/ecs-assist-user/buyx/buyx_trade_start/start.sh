# 在拉取代码后，确保进入目录并安装依赖
cd buyx_trade || exit 1
// 添加: 使用 npm 安装，避免 yarn 问题
echo "Installing dependencies with npm..."
npm install --registry=https://registry.npmmirror.com
