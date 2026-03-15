FROM node:21.5.0

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json/yarn.lock 文件
COPY package*.json yarn.lock ./
COPY buydip_scheme ./buydip_scheme

# 配置淘宝镜像源并安装依赖，同时设置SSL策略避免证书问题
RUN npm config set registry https://registry.npmmirror.com && \
    yarn config set registry https://registry.npmmirror.com && \
    yarn config set strict-ssl false && \
    yarn

# 复制项目文件到工作目录
COPY . .

# 设置环境变量
ENV PORT 4002

# 暴露端口
EXPOSE $PORT

# 启动 Next.js 应用
CMD ["yarn", "start"]