# 项目上传 GitHub 操作指南

本文说明如何人工检查并将项目源码上传到 GitHub。适用于本项目，也可作为其他 Node.js/Python 项目的参考。

## 一、上传前先确认不能上传的内容

以下内容不应提交到 GitHub：

- .env、.env.production 等真实环境配置文件；
- API Key、Token、密码、私钥（.pem、.key、.p12、.pfx）；
- SQLite 数据库及 WAL 文件（.db、.db-wal、.db-shm）；
- 用户上传图片、审核图片、案例图片、备份文件；
- 运行时生成的案例、训练数据、知识库快照、向量索引；
- 公司内部培训资料、平台手册等非公开文档；
- node_modules、Python 虚拟环境、模型缓存、日志和临时文件。

可以上传的通常是源码、测试代码、Dockerfile、Compose 配置、启动脚本、不含真实密钥的配置模板（如 .env.example）以及公开技术文档。

## 二、配置 .gitignore

先查看当前忽略规则：

~~~bash
cat .gitignore
~~~

至少应包含类似规则：

~~~gitignore
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx

node_modules/
__pycache__/
*.pyc
*.log

services/knowledge-ai/data/*.db
services/knowledge-ai/data/*.db-shm
services/knowledge-ai/data/*.db-wal
services/knowledge-ai/data/images/
services/knowledge-ai/data/review-images/
services/knowledge-ai/data/feedback-images/
services/knowledge-ai/data/backup/
services/knowledge-ai/data/cases.json
services/knowledge-ai/data/training.json
services/knowledge-ai/data/knowledge-base.json
~~~

检查某个文件是否会被忽略：

~~~bash
git check-ignore -v services/knowledge-ai/data/knowledge.db
git check-ignore -v services/knowledge-ai/data/images/example.jpg
git check-ignore -v .env
~~~

## 三、处理已经被 Git 跟踪的敏感文件

仅修改 .gitignore 不会自动停止跟踪已经提交过的文件。确认文件应保留在服务器本地、但不再进入 Git 后，使用：

~~~bash
git rm --cached -r -- services/knowledge-ai/data/images
git rm --cached -- services/knowledge-ai/data/cases.json
git rm --cached -- services/knowledge-ai/data/training.json
~~~

--cached 只从 Git 索引移除，不删除本地文件。执行后确认本地文件仍存在：

~~~bash
test -f services/knowledge-ai/data/cases.json
test -d services/knowledge-ai/data/images
~~~

如果文件本来没有被 Git 跟踪，不需要执行 git rm --cached。

## 四、上传前检查 Git 状态

~~~bash
git status --short --branch
git remote -v
git branch --show-current
git ls-files --others --exclude-standard
~~~

查看大文件：

~~~bash
find . -type f -not -path './.git/*' -size +10M -printf '%s %p\n' | sort -nr | head -30
~~~

## 五、检查密钥和异常文件

~~~bash
rg -n --hidden \
  'BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}' \
  -g '!.git/**' -g '!node_modules/**'
~~~

重点检查输出的文件内容。测试占位值可以保留，但真实 Token、密码和私钥必须删除并更换。

## 六、暂存安全文件并复核

~~~bash
git add -A
git diff --cached --name-status
git diff --cached --check
~~~

确认暂存区中没有 .env、数据库、图片、备份目录、内部 PDF、私钥、node_modules、虚拟环境或模型文件。

如果误加入文件，可以取消暂存：

~~~bash
git restore --staged -- path/to/file
~~~

## 七、提交代码

先确认远程没有新的提交：

~~~bash
git fetch origin
git rev-list --left-right --count origin/main...main
~~~

通常输出 0 0 表示本地和远程提交历史一致，可以提交。

创建提交：

~~~bash
git commit -m "feat: 完善鉴定数据管理与只读 MCP 服务"
git log -1 --oneline
git status --short --branch
~~~

## 八、GitHub 认证和推送

### 方式 A：HTTPS + Personal Access Token

远程地址为 HTTPS 时：

~~~bash
git push origin main
~~~

出现提示时，Username 填写 GitHub 用户名，例如 VAN027；Password 填写有仓库写入权限的 GitHub Personal Access Token，不是 GitHub 登录密码。

Token 至少需要对目标仓库有 Contents 写入权限。不要把 Token 写入代码、.env.example、命令截图或聊天记录。

如需临时缓存凭据，可以使用：

~~~bash
git config --global credential.helper 'cache --timeout=3600'
~~~

不建议长期使用明文凭据存储。

### 方式 B：SSH

如果服务器已经配置 GitHub SSH Key，可将远程地址改为：

~~~bash
git remote set-url origin git@github.com:VAN027/screen-damage-agent.git
ssh -T git@github.com
git push origin main
~~~

## 九、推送后验证

~~~bash
git fetch origin
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
~~~

本地 HEAD 和 origin/main 输出相同，且 git status 没有显示 ahead，表示推送成功。也可以在 GitHub 网页检查最新提交、源码目录，以及 .env、数据库、图片和内部资料是否没有出现在最新版本。

## 十、重要注意事项

从当前版本删除敏感文件，不等于从 Git 历史彻底删除。若数据库、用户图片或 Token 曾经进入旧提交，它们仍可能存在于历史对象中。

只有在确认需要清理历史、并获得团队同意后，才进行历史重写和强制推送。历史清理会影响其他协作者，不能作为普通上传步骤随意执行。

本项目的本地运行数据应继续保留在服务器数据目录中；GitHub 只保存源码、测试、模板和部署配置。
