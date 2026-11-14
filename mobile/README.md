# 静流 App（Expo / Android）

对接 TrendRadar 静流后端的移动端壳：推送流 + 设置两屏，FCM 推送经 Expo 官方服务转发（后端无需 Google 凭据）。

> 后端 API 见仓库根 `docs/jingliu-handoff.md` §5；本 App 只消费该 API + 注册推送设备。

## 首次运行（三步）

```bash
cd mobile
npm install
npx expo start          # 手机装"Expo Go"App 扫终端二维码即可打开
```

在 App 的「设置」页填写：

| 字段 | 值 |
|------|-----|
| 后端地址 | 后端所在机器的 `http://<局域网IP>:8807`（手机与后端需同网可达） |
| Bearer Token | `config.yaml` 的 `jingliu.api.auth_token` |
| EAS projectId | 见下方「推送注册前置」 |

## 推送注册前置（一次性）

1. 注册 Expo 账号（免费）：https://expo.dev
2. 本目录执行：

```bash
npm install -g eas-cli     # 或 npx eas-cli
npx eas login
npx eas init               # 自动把 projectId 写入 app.json 的 extra.eas.projectId
```

3. 回到 App「设置」页 → 点「🔔 注册到推送服务」→ 成功后 token 进入后端 `devices` 表
4. 后端 `config.yaml` 开启：`jingliu.expo.enabled: true`（Expo 通道**不需要任何 Google 凭据**）

## 出正式 APK（不装 Android Studio）

```bash
npx eas build -p android --profile preview   # 云端构建，产物给二维码/链接，手机直接安装
```

首次会引导配置构建凭据，一路默认即可（免费额度对个人足够）。

## 已知边界

- 模拟器收不了远程推送，必须真机
- 后端地址用 `http://` 明文时，App 已允许 cleartext（自部署场景）；正式对外请走 HTTPS 反代
- Expo push 服务有官方限速（约 600 条/分钟），个人使用远够
