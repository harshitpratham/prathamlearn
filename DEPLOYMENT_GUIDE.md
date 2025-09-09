# PrathamLearn EC2 Deployment Guide

## 🚀 Quick Deployment Steps

### Step 1: Connect to EC2 Instance
**Option A: AWS Console (Recommended)**
1. Go to AWS Console → EC2 → Instances
2. Select instance: `ec2-54-144-208-83.compute-1.amazonaws.com`
3. Click "Connect" → "EC2 Instance Connect"
4. Connect in browser

**Option B: SSH (if key works)**
```bash
ssh -i "PrathamLearn.pem" ubuntu@ec2-54-144-208-83.compute-1.amazonaws.com
```

### Step 2: Install Dependencies
```bash
# Make deploy script executable and run
chmod +x deploy.sh
./deploy.sh
```

### Step 3: Upload Your Code
**Option A: Using SCP (if SSH works)**
```bash
scp -i "PrathamLearn.pem" -r . ubuntu@ec2-54-144-208-83.compute-1.amazonaws.com:/var/www/prathamlearn/
```

**Option B: Using Git (if you have a repo)**
```bash
cd /var/www/prathamlearn
git clone <your-repo-url> .
```

**Option C: Manual upload via AWS Console**
1. Use EC2 Instance Connect
2. Create files manually or use wget/curl

### Step 4: Setup Environment
```bash
cd /var/www/prathamlearn
npm install

# Create .env file
cp env.example .env
nano .env
```

Add your API keys:
```env
PORT=3000
NODE_ENV=production
OPENAI_API_KEY=your_actual_openai_key
GOOGLE_AI_API_KEY=your_actual_google_ai_key
```

### Step 5: Start Application
```bash
# Start with PM2
pm2 start index.js --name "prathamlearn"
pm2 save
pm2 startup
```

### Step 6: Configure Nginx
```bash
# Copy nginx config
sudo cp nginx-config /etc/nginx/sites-available/prathamlearn
sudo ln -s /etc/nginx/sites-available/prathamlearn /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Step 7: Test Deployment
```bash
# Check if app is running
curl http://localhost:3000

# Check PM2 status
pm2 status

# Check Nginx status
sudo systemctl status nginx
```

## 🌐 Access Your App
- **URL**: http://ec2-54-144-208-83.compute-1.amazonaws.com
- **Admin**: http://ec2-54-144-208-83.compute-1.amazonaws.com/admin.html
- **Learner**: http://ec2-54-144-208-83.compute-1.amazonaws.com/learner.html

## 🔧 Troubleshooting

### If SSH doesn't work:
1. Check AWS Console → EC2 → Security Groups
2. Ensure port 22 is open for your IP
3. Use EC2 Instance Connect instead

### If app doesn't start:
```bash
# Check logs
pm2 logs prathamlearn

# Restart app
pm2 restart prathamlearn
```

### If Nginx fails:
```bash
# Test config
sudo nginx -t

# Check logs
sudo tail -f /var/log/nginx/error.log
```

## 💰 Cost
- **EC2 t2.micro**: $0/month (free tier)
- **Total**: $0/month for first 12 months
