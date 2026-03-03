#FROM sjb-storage-registry.cn-hangzhou.cr.aliyuncs.com/ops/centos7-ssh-php72:latest
FROM sjb-storage-registry.cn-hangzhou.cr.aliyuncs.com/php/node:20.18.3

# 拷贝dist包文件
COPY / /srv/www/frontend/

# 拷贝nginx配置文件
#ADD nginx.conf /etc/nginx/nginx.conf
#COPY frontend.conf /etc/nginx/conf.d/default.conf

WORKDIR /srv/www/frontend

EXPOSE 80
#EXPOSE 3000

# 启动 Nuxt 3 项目的服务器
# CMD ["node", "/srv/www/frontend/src/webhook_server.js"]
CMD sh -c 'echo "10.35.2.110 gitlab.sh.com" >> /etc/hosts && node /srv/www/frontend/src/webhook_server.js'

