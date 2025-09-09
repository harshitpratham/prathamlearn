const { kv } = require('@vercel/kv');
const fs = require('fs');
const path = require('path');

// Fallback to file system in development
const isVercel = process.env.VERCEL === '1';

class Database {
  constructor() {
    this.isVercel = isVercel;
  }

  async get(key) {
    if (this.isVercel) {
      try {
        return await kv.get(key);
      } catch (error) {
        console.error('KV get error:', error);
        return null;
      }
    } else {
      // Fallback to file system
      const filePath = path.join(__dirname, 'data', `${key}.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
      return null;
    }
  }

  async set(key, value) {
    if (this.isVercel) {
      try {
        await kv.set(key, value);
        return true;
      } catch (error) {
        console.error('KV set error:', error);
        return false;
      }
    } else {
      // Fallback to file system
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const filePath = path.join(dataDir, `${key}.json`);
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
      return true;
    }
  }

  async delete(key) {
    if (this.isVercel) {
      try {
        await kv.del(key);
        return true;
      } catch (error) {
        console.error('KV delete error:', error);
        return false;
      }
    } else {
      // Fallback to file system
      const filePath = path.join(__dirname, 'data', `${key}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    }
  }

  // Course management
  async getCourses() {
    const courses = await this.get('courses');
    return courses || {};
  }

  async saveCourse(courseId, courseData) {
    const courses = await this.getCourses();
    courses[courseId] = courseData;
    return await this.set('courses', courses);
  }

  async deleteCourse(courseId) {
    const courses = await this.getCourses();
    delete courses[courseId];
    return await this.set('courses', courses);
  }

  // Session management
  async getSessions() {
    const sessions = await this.get('sessions');
    return sessions || {};
  }

  async saveSession(sessionId, sessionData) {
    const sessions = await this.getSessions();
    sessions[sessionId] = sessionData;
    return await this.set('sessions', sessions);
  }

  async deleteSession(sessionId) {
    const sessions = await this.getSessions();
    delete sessions[sessionId];
    return await this.set('sessions', sessions);
  }

  // Course content management
  async saveCourseContent(courseId, type, content) {
    const key = `course_${courseId}_${type}`;
    return await this.set(key, content);
  }

  async getCourseContent(courseId, type) {
    const key = `course_${courseId}_${type}`;
    return await this.get(key);
  }
}

module.exports = new Database();
