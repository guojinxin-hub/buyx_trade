import dotenv from 'dotenv';

dotenv.config({path: '.env'})
import bodyParser from 'body-parser';
import express from 'express';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import cors from 'cors';
import {routers} from "./routes";
import {dbConnect} from "./dbConnect";
import { startFloatingProfitProtectionScheduler } from "./dataUtils/floatingProfitProtection";

const app = express();

app.use(cors({
    origin: true, // 允许这个源的跨源请求
    credentials: true, // 允许跨源请求携带凭据，如cookies
}))
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(express.urlencoded({extended: false}));
app.use(cookieParser());
app.use(bodyParser.urlencoded({
    extended: true
}));

// 确保数据库连接完成后再启动定时任务
async function initializeApp() {
    try {
        await dbConnect();
        console.log('数据库连接成功');
        app.use(routers);
        
        // 启动浮动盈利保护定时任务
        startFloatingProfitProtectionScheduler();
        console.log('浮动盈利保护定时任务启动成功');
    } catch (error) {
        console.error('初始化应用失败:', error);
        process.exit(1);
    }
}

initializeApp();

module.exports = app;