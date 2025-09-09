#!/bin/bash

# PrathamLearn EC2 Deployment Script
echo "🚀 Starting PrathamLearn deployment..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Puppeteer dependencies
echo "📦 Installing Puppeteer dependencies..."
sudo apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils

# Install Nginx
echo "📦 Installing Nginx..."
sudo apt install nginx -y

# Install PM2
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Create app directory
echo "📁 Creating app directory..."
sudo mkdir -p /var/www/prathamlearn
sudo chown ubuntu:ubuntu /var/www/prathamlearn

echo "✅ Dependencies installed successfully!"
echo "📋 Next steps:"
echo "1. Upload your code to /var/www/prathamlearn/"
echo "2. Run: cd /var/www/prathamlearn && npm install"
echo "3. Create .env file with your API keys"
echo "4. Run: pm2 start index.js --name prathamlearn"
echo "5. Configure Nginx reverse proxy"
