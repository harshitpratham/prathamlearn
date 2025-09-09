const request = require('supertest');

// Mock OpenAI SDK
jest.mock('openai', () => {
	class MockOpenAI {
		constructor() {}
		responses = {
			create: jest.fn(async (args) => {
				const input = typeof args.input === 'string' ? args.input : JSON.stringify(args.input);
				if (input.includes('Draft a crisp system prompt')) {
					return { output_text: 'SYSTEM PROMPT: Ask short bilingual questions.' };
				}
				if (input.includes('You are starting a new session')) {
					return { output_text: 'What is the main idea? (Hindi/English allowed)' };
				}
				if (input.includes('Evaluate the learner\'s answer')) {
					return { output_text: JSON.stringify({ correctness: true, feedback: 'Well done!', difficulty_next: 'medium', next_question: 'Explain key term?' }) };
				}
				if (input.includes('Create a short assessment')) {
					return { output_text: JSON.stringify({ questions: [ { q: 'Q1?', a: 'A1' }, { q: 'Q2?', a: 'A2' } ] }) };
				}
				if (input.includes('Learner performance:')) {
					return { output_text: 'Day 1: Revise concept A. Day 2: Practice questions.' };
				}
				return { output_text: 'ok' };
			})
		};
		audio = {
			transcriptions: { create: jest.fn(async () => ({ text: 'hello world' })) },
			speech: { create: jest.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })) }
		};
	}
	return MockOpenAI;
});

// Set API key for server
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';

const app = require('../server');

// Helper to create a course and upload text
async function setupCourse() {
	const create = await request(app).post('/api/admin/course').send({ title: 'Chapter 1', language: 'auto' });
	expect(create.status).toBe(200);
	const courseId = create.body.courseId;
	const upload = await request(app)
		.post(`/api/admin/upload/${courseId}`)
		.field('text', 'This is the chapter content about photosynthesis. प्रकाश संश्लेषण.');
	expect(upload.status).toBe(200);
	return courseId;
}

describe('PrathamLearn API', () => {
	test('create course and list', async () => {
		const res = await request(app).post('/api/admin/course').send({ title: 'Maths - Fractions' });
		expect(res.status).toBe(200);
		expect(res.body.courseId).toBeDefined();
		const list = await request(app).get('/api/courses');
		expect(list.status).toBe(200);
		expect(Array.isArray(list.body.courses)).toBe(true);
	});

	test('upload material via text and generate prompt', async () => {
		const courseId = await setupCourse();
		const prompt = await request(app).post(`/api/admin/prompt/${courseId}`);
		expect(prompt.status).toBe(200);
		expect(prompt.body.ok).toBe(true);
		expect(typeof prompt.body.promptPreview).toBe('string');
	});

	test('start learner session and answer evaluation', async () => {
		const courseId = await setupCourse();
		await request(app).post(`/api/admin/prompt/${courseId}`);
		const start = await request(app).post('/api/learner/session').send({ courseId, learnerName: 'Asha' });
		expect(start.status).toBe(200);
		expect(start.body.sessionId).toBeDefined();
		expect(typeof start.body.question).toBe('string');

		const ans = await request(app).post('/api/learner/answer').send({ sessionId: start.body.sessionId, answer: 'Explains how plants make food.' });
		expect(ans.status).toBe(200);
		expect(ans.body.correct).toBe(true);
		expect(typeof ans.body.feedback).toBe('string');
		expect(typeof ans.body.nextQuestion).toBe('string');
	});

	test('dynamic assessment and study plan', async () => {
		const courseId = await setupCourse();
		await request(app).post(`/api/admin/prompt/${courseId}`);
		const start = await request(app).post('/api/learner/session').send({ courseId });
		const assess = await request(app).post('/api/assessment/start').send({ courseId });
		expect(assess.status).toBe(200);
		expect(Array.isArray(assess.body.questions)).toBe(true);

		const plan = await request(app).post('/api/studyplan').send({ sessionId: start.body.sessionId });
		expect(plan.status).toBe(200);
		expect(typeof plan.body.plan).toBe('string');
	});

	test('ephemeral voice token endpoint', async () => {
		const courseId = await setupCourse();
		await request(app).post(`/api/admin/prompt/${courseId}`);

		// Mock global fetch for realtime session mint
		global.fetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ client_secret: { value: 'ephem_123' }, model: 'gpt-4o-realtime-preview-2024-12-17' })
		}));

		const eph = await request(app).post('/api/voice/ephemeral').query({ courseId, name: 'Asha' });
		expect(eph.status).toBe(200);
		expect(eph.body.client_secret.value).toBe('ephem_123');
	});
});
