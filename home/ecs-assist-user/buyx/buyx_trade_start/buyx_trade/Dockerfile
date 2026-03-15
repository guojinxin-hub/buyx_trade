FROM docker.io/library/node:21.5.0
WORKDIR /app
COPY package*.json yarn.lock ./
// 添加: 复制前先设置 npm 镜像源
RUN npm config set registry https://registry.npmmirror.com
COPY buydip_scheme ./buydip_scheme
