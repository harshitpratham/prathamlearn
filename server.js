const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
let puppeteer; // lazy load
const morgan = require('morgan');

// Polyfill fetch if missing (Node < 18)
if (typeof fetch === 'undefined') {
	global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

dotenv.config();

// Initialize Google AI with API key
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

const app = express();
const port = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

// Ensure required directories
const DATA_DIR = path.join(__dirname, 'data');
const COURSES_DIR = path.join(DATA_DIR, 'courses');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PAPERS_DIR = path.join(__dirname, 'public', 'papers');

for (const p of [DATA_DIR, COURSES_DIR, PAPERS_DIR]) {
	if (!fs.existsSync(p)) {
		fs.mkdirSync(p, { recursive: true });
	}
}
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ courses: {} }, null, 2));
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: {} }, null, 2));

// Storage for uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
if (DEBUG) app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// OpenAI client
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.warn('Warning: OPENAI_API_KEY not set. Add it to .env');
}
const openai = new OpenAI({ apiKey });

// Helpers
function readJSON(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (e) {
		return {};
	}
}
function writeJSON(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureCourse(courseId) {
	const db = readJSON(DB_FILE);
	if (!db.courses[courseId]) return null;
	return db.courses[courseId];
}

// Admin: create a course
app.post('/api/admin/course', (req, res) => {
	const { title, language } = req.body || {};
	if (!title) return res.status(400).json({ error: 'title required' });
	const courseId = uuidv4();
	const courseDir = path.join(COURSES_DIR, courseId);
	fs.mkdirSync(courseDir, { recursive: true });

	const db = readJSON(DB_FILE);
	db.courses[courseId] = {
		id: courseId,
		title,
		language: language || 'auto',
		materialTextPath: path.join(courseDir, 'material.txt'),
		promptPath: path.join(courseDir, 'system-prompt.txt'),
		questionBankPath: path.join(courseDir, 'question-bank.json'),
		createdAt: new Date().toISOString(),
	};
	writeJSON(DB_FILE, db);

	res.json({ courseId });
});

// Admin: upload material (pdf/text/image)
app.post('/api/admin/upload/:courseId', upload.single('material'), async (req, res) => {
	try {
		const { courseId } = req.params;
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });

		let extractedText = '';

		// If raw text also provided
		if (req.body && req.body.text) {
			extractedText += `\n${req.body.text}`;
		}

		if (req.file) {
			const filePath = req.file.path;
			const mime = req.file.mimetype;
			if (mime === 'application/pdf') {
				const dataBuffer = fs.readFileSync(filePath);
				const parsed = await pdfParse(dataBuffer);
				extractedText += `\n${parsed.text}`;
			} else if (mime.startsWith('image/')) {
				// Use OpenAI Vision to extract text from the image
				const imageB64 = fs.readFileSync(filePath).toString('base64');
				const vision = await openai.responses.create({
					model: 'gpt-4o-mini',
					input: [
						{
							role: 'user',
							content: [
								{ type: 'input_text', text: 'Extract all readable text from this image in plain text.' },
								{ type: 'input_image', image_data: imageB64, mime_type: mime },
							],
						},
					],
				});
				const text = vision?.output_text || '';
				extractedText += `\n${text}`;
			} else if (mime === 'text/plain') {
				extractedText += `\n${fs.readFileSync(filePath, 'utf8')}`;
			} else {
				return res.status(400).json({ error: `unsupported mime type: ${mime}` });
			}
		}

		if (!extractedText.trim()) {
			return res.status(400).json({ error: 'no content extracted' });
		}

		fs.writeFileSync(course.materialTextPath, extractedText.trim(), 'utf8');
		res.json({ ok: true, chars: extractedText.length });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'upload failed' });
	}
});

// Admin: generate system prompt for the voice tutor (single language) + question bank
app.post('/api/admin/prompt/:courseId', async (req, res) => {
	try {
		const { courseId } = req.params;
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });
		if (!fs.existsSync(course.materialTextPath)) return res.status(400).json({ error: 'no material uploaded' });
		const material = fs.readFileSync(course.materialTextPath, 'utf8');
		const lang = (course.language === 'hi' || course.language === 'en') ? course.language : 'en';

		console.log(`[PROMPT] Generating system prompt for course ${courseId}, lang=${lang}, material chars=${material.length}`);
		const langLine = lang === 'hi' ? 'Write all instructions and examples in Hindi. Use simple, child-friendly Hindi.' : 'Write all instructions and examples in English. Keep language simple and child-friendly.';
		const systemPromptRequest = `You are a friendly voice tutor for children. ${langLine}\n\nCreate a comprehensive, production-ready SYSTEM PROMPT for a realtime voice agent that will:\n- Be voice-first, concise, and child-friendly\n- Run a short adaptive baseline using a provided question bank\n- Keep responses <= 2 sentences\n- Provide gentle hints on mistakes and simplify follow-ups\n- After baseline, emit a study plan (we will add markers externally) and pause\n\nInclude crisp bullet sections with specific, testable rules:\n1) Role & Tone\n2) Language Policy (only ${lang === 'hi' ? 'Hindi' : 'English'})\n3) Question Policy (one short question at a time; acceptable forms; no multi-part)\n4) Adaptivity Ladder (easy→medium→hard with clear triggers)\n5) Feedback Style (hinting rules, brevity, positivity)\n6) Safety & Boundaries (no personal data, stick to chapter content)\n7) Flow Control (ask→listen→acknowledge→hint/next; recap frequency)\n8) Assessment to Plan Handoff (what constitutes end-of-baseline)\n9) Example utterances (2-3 pairs)\n\nKeep it practical. No filler.\n\nChapter Content (excerpt, do not quote verbatim in every turn):\n${material.substring(0, 20000)}`;

		const result = await openai.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [ { role: 'user', content: systemPromptRequest } ]
		});
		let promptText = result?.choices?.[0]?.message?.content || '';
		if (!promptText.trim()) {
			console.warn('[PROMPT] Empty prompt, retrying with simplified request');
			const simpleReq = `Write a concise SYSTEM PROMPT for a ${lang === 'hi' ? 'Hindi' : 'English'} child-friendly voice tutor. Bullet rules: role & tone; language policy (only ${lang === 'hi' ? 'Hindi' : 'English'}); one short question per turn; adapt easy→hard; brief hints; safety; flow; assessment to plan handoff. Keep under 400 words.\n\nChapter excerpt:\n${material.substring(0, 6000)}`;
			const retry = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: simpleReq } ] });
			promptText = retry?.choices?.[0]?.message?.content || '';
		}
		console.log(`[PROMPT] Prompt generated length=${promptText.length}`);
		if (!promptText.trim()) return res.status(500).json({ error: 'prompt generation failed' });
		fs.writeFileSync(course.promptPath, promptText.trim(), 'utf8');

		// Generate a structured question bank as JSON
		let bankCount = 0;
		try {
			console.log(`[PROMPT] Generating question bank for course ${courseId}, lang=${lang}`);
			const bankLangLine = lang === 'hi' ? 'Write questions and answers in Hindi.' : 'Write questions and answers in English.';
			const bankPrompt = `Create a question bank (JSON only). ${bankLangLine}\nReturn a JSON object: { \"questions\": [ { q: string, a: string, level: 'easy'|'medium'|'hard' } ] }.\n- Prioritize coverage of key chapter concepts\n- Keep q and a short, speakable, and child-friendly\n- Aim for 20-40 total questions if content allows, balanced across levels\n\nChapter Content:\n${material.substring(0, 18000)}`;
			const bank = await openai.chat.completions.create({
				model: 'gpt-4o-mini',
				messages: [ { role: 'user', content: bankPrompt } ]
			});
			let payload = {};
			try {
				const raw = bank.choices?.[0]?.message?.content || '{}';
				const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '');
				payload = JSON.parse(cleaned);
			} catch {}
			const questions = Array.isArray(payload.questions) ? payload.questions : [];
			bankCount = questions.length;
			fs.writeFileSync(course.questionBankPath, JSON.stringify({ questions }, null, 2), 'utf8');
			console.log(`[PROMPT] Question bank saved count=${bankCount}`);
		} catch (e) {
			console.warn('[PROMPT] Question bank generation failed:', e?.message || e);
		}

		// Update the database to mark that prompt has been generated
		const db = readJSON(DB_FILE);
		db.courses[courseId].prompt = true;
		db.courses[courseId].questionBank = (bankCount > 0);
		writeJSON(DB_FILE, db);
		
		res.json({ ok: true, promptPreview: promptText.slice(0, 300), questionCount: bankCount });
	} catch (err) {
		console.error('[PROMPT] generation failed:', err);
		res.status(500).json({ error: 'prompt generation failed' });
	}
});

// List courses
app.get('/api/courses', (req, res) => {
	const db = readJSON(DB_FILE);
	const list = Object.values(db.courses || {}).map(c => ({ 
		id: c.id, 
		title: c.title,
		prompt: c.prompt || false,
		language: c.language,
		questionBank: c.questionBank || false
	}));
	res.json({ courses: list });
});

// Fetch full generated system prompt
app.get('/api/admin/prompt/:courseId', (req, res) => {
	const { courseId } = req.params;
	const course = ensureCourse(courseId);
	if (!course) return res.status(404).json({ error: 'course not found' });
	if (!fs.existsSync(course.promptPath)) return res.status(404).json({ error: 'prompt not found' });
	const prompt = fs.readFileSync(course.promptPath, 'utf8');
	res.json({ prompt });
});

// Learner: start a session (returns first question)
app.post('/api/learner/session', async (req, res) => {
	try {
		const { courseId, learnerName } = req.body || {};
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });
		if (!fs.existsSync(course.promptPath)) return res.status(400).json({ error: 'system prompt missing' });
		const systemPrompt = fs.readFileSync(course.promptPath, 'utf8');
		const material = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';

		const sessionId = uuidv4();
		const sessions = readJSON(SESSIONS_FILE);
		sessions.sessions[sessionId] = {
			id: sessionId,
			courseId,
			name: learnerName || 'Learner',
			createdAt: new Date().toISOString(),
			level: 'easy',
			history: [],
			score: 0,
			total: 0,
		};
		writeJSON(SESSIONS_FILE, sessions);

		const firstQuestionPrompt = `System Prompt:\n${systemPrompt}\n\nYou are starting a new session. Create the first question from the chapter content below. Start simple. Ask only one short question.\n\nChapter Content:\n${material.substring(0, 4000)}`;
		const ai = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: firstQuestionPrompt } ] });
		const question = ai?.choices?.[0]?.message?.content?.trim() || 'Let\'s begin. What is the main idea of this chapter?';

		res.json({ sessionId, question });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to start session' });
	}
});

// Learner: submit an answer, get next question and simple evaluation
app.post('/api/learner/answer', async (req, res) => {
	try {
		const { sessionId, answer, question } = req.body || {};
		if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
		const sessions = readJSON(SESSIONS_FILE);
		const session = sessions.sessions[sessionId];
		if (!session) return res.status(404).json({ error: 'session not found' });
		const db = readJSON(DB_FILE);
		const course = db.courses[session.courseId];
		if (!course) return res.status(404).json({ error: 'course not found' });
		const material = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';
		const systemPrompt = fs.existsSync(course.promptPath) ? fs.readFileSync(course.promptPath, 'utf8') : '';

		const evalPrompt = `System Prompt (Tutor Rules):\n${systemPrompt}\n\nEvaluate the learner's answer based on the chapter content.\nReturn JSON with keys: correctness (true/false), feedback (<= 2 sentences, same language as learner), difficulty_next (easy|medium|hard), next_question (one short question).\n\nChapter Content:\n${material.substring(0, 6000)}\n\nConversation History:\n${session.history.map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n')}\n\nLatest Question:\n${question || ''}\n\nLatest Answer:\n${answer || ''}`;

		const ai = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: evalPrompt } ] });
		let payload = {};
		try {
			payload = JSON.parse(ai.choices?.[0]?.message?.content || '{}');
		} catch (e) {
			payload = { correctness: false, feedback: 'Thanks! Let\'s try another one.', difficulty_next: 'easy', next_question: 'Can you explain the main idea?' };
		}

		session.history.push({ q: question || payload.prev_question || '', a: answer || '' });
		session.level = payload.difficulty_next || session.level;
		session.total += 1;
		if (payload.correctness) session.score += 1;
		writeJSON(SESSIONS_FILE, sessions);

		res.json({
			correct: !!payload.correctness,
			feedback: payload.feedback || 'Good effort!',
			nextQuestion: payload.next_question || 'Here\'s another one: explain the key idea.',
			score: session.score,
			total: session.total,
			level: session.level,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to process answer' });
	}
});

// Read a session for live UI
app.get('/api/learner/session/:sessionId', (req, res) => {
	const { sessionId } = req.params;
	const sessions = readJSON(SESSIONS_FILE);
	const s = sessions.sessions[sessionId];
	if (!s) return res.status(404).json({ error: 'session not found' });
	
	// Include question bank if available
	const db = readJSON(DB_FILE);
	const course = db.courses[s.courseId];
	const questionBank = course?.questionBank || [];
	
	res.json({ 
		id: s.id, 
		courseId: s.courseId, 
		name: s.name, 
		level: s.level, 
		score: s.score, 
		total: s.total, 
		history: s.history,
		questionBank: questionBank 
	});
});

// Dynamic assessment: quick quiz generation
app.post('/api/assessment/start', async (req, res) => {
	try {
		const { courseId } = req.body || {};
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });
		const material = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';
		const prompt = `Create a short assessment (5 questions) based on the chapter content. Mix easy/medium/hard. Reply as JSON array with objects { q, a }. Use bilingual-friendly simple language.`;
		const ai = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: `${prompt}\n\nContent:\n${material.substring(0, 7000)}` } ] });
		let parsed = { questions: [] };
		try { parsed = JSON.parse(ai.choices?.[0]?.message?.content || '{}'); } catch {}
		res.json({ questions: parsed.questions || [] });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to create assessment' });
	}
});

// Analyze conversation transcript
app.post('/api/analyze-transcript', async (req, res) => {
	try {
		const { sessionId, transcript } = req.body;
		if (!sessionId || !transcript) return res.status(400).json({ error: 'sessionId and transcript required' });
		
		const sessions = readJSON(SESSIONS_FILE);
		const session = sessions.sessions[sessionId];
		if (!session) return res.status(404).json({ error: 'session not found' });
		
		const db = readJSON(DB_FILE);
		const course = db.courses[session.courseId];
		if (!course) return res.status(404).json({ error: 'course not found' });
		
		// Load question bank
		let questionBank = { questions: [] };
		try {
			if (fs.existsSync(course.questionBankPath)) {
				questionBank = readJSON(course.questionBankPath);
			}
		} catch {}
		
		console.log('[ANALYZE] Analyzing transcript for session:', sessionId);
		
		// Call LLM to analyze the transcript
		const analysisPrompt = `Analyze this voice assessment conversation transcript and extract Q&A pairs.

Question Bank (expected questions):
${JSON.stringify(questionBank.questions.slice(0, 10), null, 2)}

Conversation Transcript:
${transcript}

Instructions:
1. Look for questions asked by the Assistant (usually ending with "?")
2. Find the corresponding user answer marked with [USER ANSWER]: that sometimes comes AFTER the next question that mean the answer of question 1 is most probably after the question 2
3. The assistant may be interrupted while speaking, so reconstruct the full question
4. Match questions to the question bank where possible
5. The user might be saying the right answer but the assistant might have interpreted it wrong and transcribed it wrong, look for patterns, for example if the answer was "Cow" the transcript might have "kao"

For the transcript above, extract Q&A pairs in this JSON format:
{
  "qa_pairs": [
    {
      "question": "exact question from transcript or matched from question bank",
      "user_answer": "what the user answered",
      "correct": true/false,
      "feedback": "brief explanation"
    }
  ]
}

Important:
- Look for [USER ANSWER]: markers to identify user responses
- Map each user answer to the question that was asked most recently before that answer
- If a user answer appears while the assistant is still asking a question, wait for the complete question
- Evaluate answers based on scientific accuracy
- Be lenient with children's answers (accept partial correctness)
- If user says "I don't know" or similar, mark as incorrect but be encouraging
- Consider the sequence: Question -> User Answer -> Agent Response -> Next Question`;

		const ai = await openai.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: analysisPrompt }],
			max_tokens: 2000,
			response_format: { type: 'json_object' }
		});
		
		const analysisText = ai?.choices?.[0]?.message?.content || '{}';
		const analysis = JSON.parse(analysisText);
		
		// Update session with analyzed Q&A
		session.history = [];
		let score = 0;
		
		(analysis.qa_pairs || []).forEach((qa, idx) => {
			session.history.push({
				q: qa.question,
				a: qa.user_answer,
				correct: qa.correct,
				feedback: qa.feedback
			});
			if (qa.correct) score++;
		});
		
		session.score = score;
		session.total = session.history.length;
		session.level = score >= session.total * 0.8 ? 'Advanced' : 
		                score >= session.total * 0.5 ? 'Intermediate' : 'Beginner';
		
		// Save updated session
		sessions.sessions[sessionId] = session;
		writeJSON(SESSIONS_FILE, sessions);
		
		console.log(`[ANALYZE] Extracted ${session.history.length} Q&A pairs, score: ${score}/${session.total}`);
		
		res.json({
			qa_pairs: analysis.qa_pairs,
			score: session.score,
			total: session.total,
			level: session.level
		});
		
	} catch (err) {
		console.error('[ANALYZE] Error:', err);
		res.status(500).json({ error: 'failed to analyze transcript' });
	}
});

// Study plan generation based on performance
app.post('/api/studyplan', async (req, res) => {
	try {
		const { sessionId } = req.body || {};
		const sessions = readJSON(SESSIONS_FILE);
		const session = sessions.sessions[sessionId];
		if (!session) return res.status(404).json({ error: 'session not found' });
		const db = readJSON(DB_FILE);
		const course = db.courses[session.courseId];
		const material = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';

		// Build detailed Q&A history
		const qaHistory = session.history.map(h => `Q: ${h.q}\nA: ${h.a}\nCorrect: ${h.correct ? 'Yes' : 'No'}`).join('\n\n');
		
		const planPrompt = `Based on the learner's assessment results, create a personalized study plan.

Learner Performance:
- Score: ${session.score}/${session.total} (${session.total ? Math.round((session.score/session.total)*100) : 0}%)
- Level: ${session.level}
- Language: ${course.language === 'hi' ? 'Hindi' : 'English'}

Assessment Q&A:
${qaHistory}

Original Chapter Content:
${material.substring(0, 7000)}

Create a detailed, adaptive 1-week study plan that:
1. Focuses on concepts the learner struggled with
2. Reinforces areas they understood well
3. Gradually builds from their current level
4. Uses simple, child-friendly language
5. Includes daily tasks and practice questions
6. Only uses content from this chapter

Format as a clear day-by-day plan in ${course.language === 'hi' ? 'Hindi' : 'English'}.`;
		const ai = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: planPrompt } ] });
		const planText = ai?.choices?.[0]?.message?.content?.trim() || 'Revise key concepts daily and practice 3 questions each day.';
		res.json({ plan: planText });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to create study plan' });
	}
});

// Generate Assessment Questions for Handwritten Assessment
app.post('/api/assessment/questions', async (req, res) => {
	try {
		const { courseId, learnerName } = req.body;
		
		if (!courseId) {
			return res.status(400).json({ error: 'Course ID required' });
		}

		const course = ensureCourse(courseId);
		if (!course) {
			return res.status(404).json({ error: 'Course not found' });
		}

		// Load question bank
		let questionBank = { questions: [] };
		try {
			if (fs.existsSync(course.questionBankPath)) {
				questionBank = readJSON(course.questionBankPath);
			}
		} catch (e) {
			console.warn('[QUESTIONS] Failed to load question bank:', e.message);
		}

		// Determine number of questions based on material length
		const materialText = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';
		const wc = (materialText.trim().match(/\S+/g) || []).length;
		let numQuestions = wc < 300 ? 3 : wc < 1200 ? 5 : wc < 3000 ? 7 : 10;
		
		// Select questions from the bank
		const selectedQuestions = questionBank.questions.slice(0, numQuestions);
		
		console.log(`[QUESTIONS] Generated ${selectedQuestions.length} questions for course ${courseId}`);
		res.json({ questions: selectedQuestions });

	} catch (err) {
		console.error('[QUESTIONS] Generation failed:', err);
		res.status(500).json({ error: 'Failed to generate questions' });
	}
});

// Handwritten Assessment: Analyze uploaded image using Google Gemini Flash
app.post('/api/assessment/handwritten', upload.single('image'), async (req, res) => {
	try {
		const { courseId, learnerName, questions } = req.body;
		const file = req.file;
		
		if (!file) {
			return res.status(400).json({ error: 'No image uploaded' });
		}
		
		if (!courseId) {
			return res.status(400).json({ error: 'Course ID required' });
		}

		const course = ensureCourse(courseId);
		if (!course) {
			return res.status(404).json({ error: 'Course not found' });
		}

		// Parse questions from frontend
		let questionBank = { questions: [] };
		try {
			if (questions) {
				questionBank = { questions: JSON.parse(questions) };
			} else {
				// Fallback: load from question bank file
				if (fs.existsSync(course.questionBankPath)) {
					questionBank = readJSON(course.questionBankPath);
				}
			}
		} catch (e) {
			console.warn('[HANDWRITTEN] Failed to parse questions:', e.message);
		}

		// Convert image to base64
		const imageBuffer = fs.readFileSync(file.path);
		const base64Image = imageBuffer.toString('base64');
		const mimeType = file.mimetype;

		// Create analysis prompt
		const analysisPrompt = `Analyze this handwritten assessment image and extract the student's answers to science questions.

QUESTION BANK (expected questions):
${JSON.stringify(questionBank.questions, null, 2)}

INSTRUCTIONS:
1. Identify all questions visible in the image
2. Extract the student's handwritten answers for each question
3. Compare answers against the correct answers from the question bank
4. Determine if each answer is correct, partially correct, or incorrect
5. Provide feedback for incorrect answers
6. Calculate overall score and learning level

Return your analysis in this exact JSON format:
{
  "score": number,
  "total": number,
  "level": "Beginner|Intermediate|Advanced",
  "qaPairs": [
    {
      "question": "question text",
      "answer": "student's answer",
      "correct": boolean,
      "feedback": "helpful feedback if incorrect"
    }
  ]
}

Be lenient with children's answers - accept partial correctness and common misspellings.`;

		// Use Google Gemini Flash for image analysis
		const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
		
		const result = await model.generateContent([
			analysisPrompt,
			{
				inlineData: {
					data: base64Image,
					mimeType: mimeType
				}
			}
		]);

		const response = await result.response;
		const analysisText = response.text();
		
		// Parse the JSON response
		let analysis;
		try {
			// Clean up the response text to extract JSON
			const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				analysis = JSON.parse(jsonMatch[0]);
			} else {
				throw new Error('No JSON found in response');
			}
		} catch (parseError) {
			console.error('[HANDWRITTEN] JSON parse error:', parseError);
			console.error('[HANDWRITTEN] Raw response:', analysisText);
			
			// Fallback: create a basic analysis
			analysis = {
				score: 0,
				total: questionBank.questions.length || 1,
				level: "Beginner",
				qaPairs: questionBank.questions.slice(0, 3).map((q, i) => ({
					question: q.q,
					answer: "Could not extract answer",
					correct: false,
					feedback: "Unable to analyze handwritten answer"
				}))
			};
		}

		// Clean up uploaded file
		fs.unlinkSync(file.path);

		console.log(`[HANDWRITTEN] Analysis complete for course ${courseId}, score: ${analysis.score}/${analysis.total}`);
		res.json(analysis);

	} catch (err) {
		console.error('[HANDWRITTEN] Analysis failed:', err);
		res.status(500).json({ error: 'Failed to analyze handwritten assessment' });
	}
});

// Study Plan for Handwritten Assessment
app.post('/api/studyplan/handwritten', async (req, res) => {
	try {
		const { courseId, score, total, level, qaPairs } = req.body;
		
		if (!courseId) {
			return res.status(400).json({ error: 'Course ID required' });
		}

		const course = ensureCourse(courseId);
		if (!course) {
			return res.status(404).json({ error: 'Course not found' });
		}

		const material = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';

		// Build detailed Q&A history
		const qaHistory = qaPairs.map(qa => `Q: ${qa.question}\nA: ${qa.answer}\nCorrect: ${qa.correct ? 'Yes' : 'No'}${qa.feedback ? `\nFeedback: ${qa.feedback}` : ''}`).join('\n\n');
		
		const planPrompt = `Based on the learner's handwritten assessment results, create a personalized study plan.

Learner Performance:
- Score: ${score}/${total} (${total ? Math.round((score/total)*100) : 0}%)
- Level: ${level}
- Language: ${course.language === 'hi' ? 'Hindi' : 'English'}

Assessment Q&A:
${qaHistory}

Original Chapter Content:
${material.substring(0, 7000)}

Create a detailed, adaptive 1-week study plan that:
1. Focuses on concepts the learner struggled with (incorrect answers)
2. Reinforces areas they understood well (correct answers)
3. Gradually builds from their current level
4. Uses simple, child-friendly language
5. Includes daily tasks and practice questions
6. Only uses content from this chapter
7. Provides specific guidance for improving handwriting if needed

Format as a clear day-by-day plan in ${course.language === 'hi' ? 'Hindi' : 'English'}.`;

		const ai = await openai.chat.completions.create({ 
			model: 'gpt-4o-mini', 
			messages: [{ role: 'user', content: planPrompt }] 
		});
		
		const planText = ai?.choices?.[0]?.message?.content?.trim() || 'Revise key concepts daily and practice 3 questions each day.';
		res.json({ plan: planText });

	} catch (err) {
		console.error('[HANDWRITTEN] Study plan generation failed:', err);
		res.status(500).json({ error: 'Failed to create study plan' });
	}
});

// STT: Transcribe audio (fallback, not used by realtime flow)
app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: 'audio required' });
		const transcription = await openai.audio.transcriptions.create({
			model: 'whisper-1',
			audio: fs.createReadStream(req.file.path),
			response_format: 'json',
		});
		res.json({ text: transcription.text || '' });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'transcription failed' });
	}
});

// TTS: Return MP3 audio for given text (fallback)
app.post('/api/voice/tts', async (req, res) => {
	try {
		const { text, voice } = req.body || {};
		if (!text) return res.status(400).json({ error: 'text required' });
		const speech = await openai.audio.speech.create({
			model: 'gpt-4o-mini-tts',
			voice: voice || 'alloy',
			input: text,
			format: 'mp3',
		});
		const buffer = Buffer.from(await speech.arrayBuffer());
		res.setHeader('Content-Type', 'audio/mpeg');
		res.send(buffer);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'tts failed' });
	}
});

// Voice: mint ephemeral token for Realtime WebRTC
app.post('/api/voice/ephemeral', async (req, res) => {
	try {
		const courseId = (req.query.courseId || req.body?.courseId || '').toString();
		const learnerName = (req.query.name || req.body?.name || 'Learner').toString();
		const preferredLang = (req.query.lang || req.body?.lang || '').toString();
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });
		const systemPrompt = fs.existsSync(course.promptPath) ? fs.readFileSync(course.promptPath, 'utf8') : 'You are a helpful tutor.';

		// Determine language and question counts
		const materialText = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';
		const wc = (materialText.trim().match(/\S+/g) || []).length;
		let baselineQuestions = wc < 300 ? 3 : wc < 1200 ? 5 : wc < 3000 ? 7 : 10;
		const reassessQuestions = Math.max(3, Math.round(baselineQuestions / 2));
		const lang = (preferredLang === 'hi' || preferredLang === 'en') ? preferredLang : ((course.language === 'hi' || course.language === 'en') ? course.language : 'en');
		console.log(`[VOICE] session mint for course ${courseId}, learner=${learnerName}, lang=${lang}, baseline=${baselineQuestions}`);

		// Load question bank, if any
		let questionBank = { questions: [] };
		try {
			if (fs.existsSync(course.questionBankPath)) {
				questionBank = readJSON(course.questionBankPath);
			}
		} catch {}
		const qbString = JSON.stringify(questionBank);
		const qbSnippet = qbString.length > 5000 ? qbString.slice(0, 5000) + '...TRUNCATED' : qbString;

		const model = 'gpt-4o-realtime-preview-2024-12-17';
		const languageDirective = lang === 'hi' ? 'Use only Hindi.' : 'Use only English.';
		const body = {
			model,
			voice: 'alloy',
			modalities: ['audio', 'text'],
			input_audio_transcription: { model: 'whisper-1' },
			instructions: `You are a  ASSESSMENT AGENT. Your ONLY job is to ask questions from the provided question bank.

MANDATORY QUESTION BANK (use ONLY these questions - NO exceptions):
${qbSnippet}

ABSOLUTE RULES - FOLLOW EXACTLY:
- ${languageDirective} 
- Ask ONLY the questions from the question bank above - NO other questions
- Start with the FIRST question from the bank immediately
- Ask exactly ${baselineQuestions} questions from the bank in order
- CRITICAL: You must wait for the user to finish speaking completely and answer the questionbefore you respond
- After each answer, ONLY say "Okay" or "Alright" then WAIT 8 seconds before next question
- NO explanations, NO correct answers, NO hints, NO teaching
- Count internally: 1 of ${baselineQuestions}, 2 of ${baselineQuestions}, etc.
- After Last question ${baselineQuestions} is answered wait for 8 seconds, say "Assessment complete" and emit:
  <<PLAN_START>>
  [Generate personalized study plan based on which questions they got right/wrong]
  <<PLAN_END>>

TURN-TAKING PROTOCOL:
1. Ask a question from the bank
2. Wait for user to speak and finish completely
3. Say "Okay" or "Alright" 
4. Wait 8 seconds
5. Ask next question from the bank
6. Repeat until all ${baselineQuestions} questions are done and wait for answer

CRITICAL: 
- Use ONLY questions from the provided bank - NO questions about atmosphere, capitals, or any other topics
- Do not start the next question until the user has completely finished their answer and you have acknowledged it
- Do not interrupt the user while they are speaking"`
		};

		const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		});
		const text = await r.text();
		let json;
		try { json = JSON.parse(text); } catch { json = { raw: text }; }
		if (!r.ok) return res.status(r.status).json(json);
		// Attach baseline so the client can auto-finish after assessment
		res.json({ ...json, baselineQuestions });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to mint ephemeral token' });
	}
});

// Generate HTML question paper
app.post('/api/papers/html', async (req, res) => {
	try {
		const { courseId, learnerName } = req.body || {};
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });
		if (!fs.existsSync(course.materialTextPath)) return res.status(400).json({ error: 'no material uploaded for this course' });
		const material = fs.readFileSync(course.materialTextPath, 'utf8');

		const paperPrompt = `You are a friendly voice tutor for children.\n\nCreate a comprehensive, production-ready SYSTEM PROMPT for a realtime voice agent that will:\n- Be voice-first, concise, and child-friendly\n- Run a short adaptive baseline using a provided question bank\n- Keep responses <= 2 sentences\n- Provide gentle hints on mistakes and simplify follow-ups\n- After baseline, emit a study plan (we will add markers externally) and pause\n\nInclude crisp bullet sections with specific, testable rules:\n1) Role & Tone\n2) Language Policy (only ${course.language === 'hi' ? 'Hindi' : 'English'})\n3) Question Policy (one short question at a time; acceptable forms; no multi-part)\n4) Adaptivity Ladder (easy→medium→hard with clear triggers)\n5) Feedback Style (hinting rules, brevity, positivity)\n6) Safety & Boundaries (no personal data, stick to chapter content)\n7) Flow Control (ask→listen→acknowledge→hint/next; recap frequency)\n8) Assessment to Plan Handoff (what constitutes end-of-baseline)\n9) Example utterances (2-3 pairs)\n\nKeep it practical. No filler.\n\nChapter Content (excerpt, do not quote verbatim in every turn):\n${material.substring(0, 20000)}`;

		const systemPrompt = fs.existsSync(course.promptPath) ? fs.readFileSync(course.promptPath, 'utf8') : 'You are a helpful tutor.';
		const questionBank = fs.existsSync(course.questionBankPath) ? readJSON(course.questionBankPath) : { questions: [] };

		const ai = await openai.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [ { role: 'user', content: `${paperPrompt}\n\nSystem Prompt:\n${systemPrompt}\n\nQuestion Bank:\n${JSON.stringify(questionBank, null, 2)}\n\nGenerate a comprehensive, well-formatted HTML question paper. Include:\n- A title (e.g., "Chapter 1: Introduction to ${course.title}").\n- A brief introduction (e.g., "This is a practice test for Chapter 1 of ${course.title}").\n- A table of contents (e.g., "1. Introduction, 2. Key Concepts, 3. Questions").\n- A list of questions (each question should be a separate section, numbered). Each question should:\n  - Have a clear, concise question text.\n  - Include a space for the learner's answer.\n  - Have a hint (if applicable).\n  - Be in the learner's language (${course.language === 'hi' ? 'Hindi' : 'English'}).\n- A summary of the paper at the end.\n\nThe HTML should be valid and include all necessary tags (e.g., <h1>, <h2>, <p>, <ul>, <li>, <div>, <span>).` } ]
		});
		const htmlContent = ai?.choices?.[0]?.message?.content || '';
		if (!htmlContent.trim()) return res.status(500).json({ error: 'HTML paper generation failed' });

		const paperPath = path.join(PAPERS_DIR, `${courseId}-${uuidv4()}.html`);
		fs.writeFileSync(paperPath, htmlContent.trim(), 'utf8');

		res.json({ paperPath });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to generate HTML paper' });
	}
});

// Generate PDF from HTML (fallback)
app.post('/api/papers/pdf', async (req, res) => {
	try {
		const { paperPath } = req.body || {};
		if (!paperPath) return res.status(400).json({ error: 'paperPath required' });
		if (!fs.existsSync(paperPath)) return res.status(404).json({ error: 'paper not found' });

		if (!puppeteer) {
			puppeteer = require('puppeteer');
		}

		const browser = await puppeteer.launch();
		const page = await browser.newPage();
		await page.goto(`file://${paperPath}`);
		const pdf = await page.pdf({ format: 'A4' });
		await browser.close();

		res.setHeader('Content-Type', 'application/pdf');
		res.send(pdf);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'failed to generate PDF' });
	}
});

// HTML/PDF question paper from question bank
app.post('/api/assessment/paper', async (req, res) => {
	try {
		const { courseId } = req.body || {};
		const course = ensureCourse(courseId);
		if (!course) return res.status(404).json({ error: 'course not found' });
		let bank = { questions: [] };
		if (fs.existsSync(course.questionBankPath)) {
			bank = readJSON(course.questionBankPath);
		}
		if (!Array.isArray(bank.questions) || bank.questions.length === 0) {
			console.warn(`[PAPER] No question bank for course ${courseId} — generating fallback from material`);
			const material = fs.existsSync(course.materialTextPath) ? fs.readFileSync(course.materialTextPath, 'utf8') : '';
			const genPrompt = `Create a JSON object with key "questions" containing 20 items. Each item: { q: string (short, speakable, child-friendly), a: string (concise ideal answer), level: 'easy'|'medium'|'hard' }. Cover key concepts from this chapter. Language: ${course.language === 'hi' ? 'Hindi' : 'English'}.\n\nChapter Content:\n${material.substring(0, 12000)}`;
			try {
				const resp = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: genPrompt } ] });
				const raw = resp?.choices?.[0]?.message?.content || '{}';
				const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '');
				const parsed = JSON.parse(cleaned);
				if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
					bank = { questions: parsed.questions };
					fs.writeFileSync(course.questionBankPath, JSON.stringify(bank, null, 2), 'utf8');
					console.log(`[PAPER] Fallback question bank generated count=${bank.questions.length}`);
				}
			} catch (e) {
				console.warn('[PAPER] Fallback generation failed:', e?.message || e);
			}
		}
		if (!Array.isArray(bank.questions) || bank.questions.length === 0) {
			return res.status(400).json({ error: 'question bank not available; try generating prompt again' });
		}
		console.log(`[PAPER] Generating paper for course ${courseId}, questions=${bank.questions.length}`);
		const title = `Assessment - ${course.title}`;
		const langName = course.language === 'hi' ? 'Hindi' : 'English';

		// Build MCQ + FIB JSON via LLM, then render controlled HTML
		let mcq = [], fib = [];
		try {
			const compactBank = bank.questions.slice(0, 60); // cap prompt size
			const jsonPrompt = `From the question bank, produce EXACT JSON with keys {\"mcq\":[],\"fib\":[]} only.\n\nRules:\n- mcq: 12 items. Each item: { q: string, options: [string,string,string,string], correctIndex: 0|1|2|3 }. Options must be plausible; exactly one correct.\n- fib: 8 items. Each item: { q: string with a single blank using \"____\", answer: string }. Keep blanks short and unambiguous.\n- Use ${langName} only.\n- Do NOT include any extra keys, commentary, or code fences.\n\nQuestion Bank:\n${JSON.stringify({ questions: compactBank }).slice(0, 18000)}`;
			const resp = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [ { role: 'user', content: jsonPrompt } ] });
			let content = resp?.choices?.[0]?.message?.content || '{}';
			content = content.replace(/```json\s*/gi, '').replace(/```/g, '');
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed.mcq)) mcq = parsed.mcq.slice(0, 20);
			if (Array.isArray(parsed.fib)) fib = parsed.fib.slice(0, 10);
			console.log(`[PAPER] LLM MCQ=${mcq.length}, FIB=${fib.length}`);
		} catch (e) {
			console.warn('[PAPER] MCQ/FIB JSON generation failed:', e?.message || e);
		}

		let html;
		if (mcq.length && fib.length) {
			const style = 'body{font-family:Arial,Helvetica,Sans-Serif;margin:24px}h1{margin:0 0 8px}h2{margin:16px 0 8px}ol{padding-left:20px}li{margin:8px 0}small{color:#666}.opts{margin:6px 0 0 0;padding-left:18px}.opts li{list-style-type: upper-alpha;margin:4px 0}';
			const keyMCQ = mcq.map((q,i)=>`Q${i+1}: ${String.fromCharCode(65 + (q.correctIndex||0))}`).join(', ');
			const keyFIB = fib.map((q,i)=>`Q${i+1}: ${q.answer}`).join('; ');
			html = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>`+
				`<h1>${title}</h1><small>Language: ${langName}</small>`+
				`<p>Instructions: Attempt all questions. Read carefully and choose/enter the best answer.</p>`+
				`<h2>A) Multiple Choice Questions</h2><ol>`+
				mcq.map((q)=>`<li>${q.q}<ul class="opts">${(q.options||[]).slice(0,4).map(opt=>`<li>${opt}</li>`).join('')}</ul></li>`).join('')+
				`</ol>`+
				`<h2>B) Fill in the Blanks</h2><ol>`+
				fib.map((q)=>`<li>${q.q}</li>`).join('')+
				`</ol>`+
				`<h2>Answer Key</h2><p><strong>MCQ:</strong> ${keyMCQ}</p><p><strong>Fill-in:</strong> ${keyFIB}</p>`+
				`</body></html>`;
		} else {
			// Fallback to simple list if LLM JSON failed
			const now = new Date().toLocaleString();
			html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,Sans-Serif;margin:24px}h1{margin:0 0 8px}ol{padding-left:20px}li{margin:8px 0}small{color:#666}</style></head><body><h1>${title}</h1><small>${now}</small><ol>${bank.questions.map((q,i)=>`<li><strong>Q${i+1}:</strong> ${q.q}</li>`).join('')}</ol></body></html>`;
		}

		// Generate PDF path
		const paperId = uuidv4();
		const pdfFile = path.join(PAPERS_DIR, `${paperId}.pdf`);
		try {
			if (!puppeteer) puppeteer = (await import('puppeteer')).default;
			const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
			const page = await browser.newPage();
			await page.setContent(html, { waitUntil: 'networkidle0' });
			await page.pdf({ path: pdfFile, format: 'A4', printBackground: true });
			await browser.close();
			console.log(`[PAPER] PDF saved ${pdfFile}`);
		} catch (e) {
			console.warn('[PAPER] PDF generation failed; returning HTML only:', e?.message || e);
		}

		const publicPath = `/papers/${path.basename(pdfFile)}`;
		const pdfExists = fs.existsSync(pdfFile);
		res.json({ 
			html, 
			pdfPath: pdfExists ? publicPath : null,
			pdfUrl: pdfExists ? publicPath : null  // For backward compatibility
		});
	} catch (err) {
		console.error('[PAPER] generation failed:', err);
		res.status(500).json({ error: 'failed to generate paper' });
	}
});

// Global error handler
app.use((err, req, res, next) => {
	console.error('[UNHANDLED]', err);
	res.status(500).json({ error: 'internal error' });
});

// Keep this at the end of the file
if (require.main === module) {
	app.listen(port, () => {
		console.log(`Server running on http://localhost:${port}`);
	});
}

module.exports = app;
