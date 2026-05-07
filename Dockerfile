FROM public.ecr.aws/lambda/nodejs:20

RUN dnf install -y poppler-utils

WORKDIR /var/task

COPY package*.json ./

RUN npm install

COPY . .

CMD ["index.handler"]