import test, { ExecutionContext } from 'ava';
import * as sinon from 'sinon';
import * as proxyquire from 'proxyquire';
import * as path from 'path';

import { readFile, readFileAsync } from '../../../../src/lib/utils/misc';
import { JobStatus, HintStatus } from '../../../../src/lib/enums/status';
import { IJob } from '../../../../src/lib/types';

const IssueReporter = function () { };

IssueReporter.prototype.report = () => { };

const github = { IssueReporter };

const logger = { error() { } };

type ResultQueue = {
    deleteMessage: () => void;
    listen: () => void;
};

const resultsQueue: ResultQueue = {
    deleteMessage() { },
    listen() { }
};
const Queue = function (): ResultQueue {
    return resultsQueue;
};
const queueObject = { Queue };
const database = {
    connect() { },
    job: {
        get(): Promise<any> {
            return null;
        },
        update() { }
    },
    lock(): Promise<string> {
        return null;
    },
    unlock() { }
};

const data = {
    error: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'error.json'))),
    finished: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'finished.json'))),
    finishedPart1: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'finished-part1.json'))),
    finishedPart2: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'finished-part2.json'))),
    finishedWithError: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'finished-with-error.json'))),
    started: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'started.json'))),
    startedNewId: JSON.parse(readFile(path.join(__dirname, 'fixtures', 'started-new-id.json')))
};

type SyncTestContext = {
    sandbox: sinon.SinonSandbox;
    job: any;
    queueObjectQueueStub: sinon.SinonStub;
    databaseConnectStub: sinon.SinonStub;
    resultsQueueListenStub: sinon.SinonStub;
    databaseLockStub: sinon.SinonStub;
    databaseUnlockStub: sinon.SinonStub;
    databaseJobUpdateStub: sinon.SinonStub;
    issueReporterReportSpy: sinon.SinonSpy;
    databaseJobGetStub: sinon.SinonStub;
};

type TestContext = ExecutionContext<SyncTestContext>;

proxyquire('../../../../src/lib/microservices/sync-service/sync-service', {
    '../../common/database/database': database,
    '../../common/github/issuereporter': github,
    '../../common/queue/queue': queueObject,
    '../../utils/logging': logger
});

import * as sync from '../../../../src/lib/microservices/sync-service/sync-service';

test.beforeEach(async (t: TestContext) => {
    const sandbox = sinon.createSandbox();

    const queueObjectQueueStub = sandbox.stub(queueObject, 'Queue').returns(resultsQueue);
    const databaseConnectStub = sandbox.stub(database, 'connect').resolves();
    const resultsQueueListenStub = sandbox.stub(resultsQueue, 'listen').resolves();
    const databaseLockStub = sandbox.stub(database, 'lock').resolves('asdf');
    const databaseUnlockStub = sandbox.stub(database, 'unlock').resolves();
    const databaseJobUpdateStub = sandbox.stub(database.job, 'update').resolves();
    const issueReporterReportSpy = sandbox.spy(IssueReporter.prototype, 'report');

    t.context.job = JSON.parse(await readFileAsync(path.join(__dirname, 'fixtures', 'dbdata.json')));

    t.context.queueObjectQueueStub = queueObjectQueueStub;
    t.context.databaseConnectStub = databaseConnectStub;
    t.context.resultsQueueListenStub = resultsQueueListenStub;
    t.context.databaseLockStub = databaseLockStub;
    t.context.databaseUnlockStub = databaseUnlockStub;
    t.context.databaseJobUpdateStub = databaseJobUpdateStub;
    t.context.issueReporterReportSpy = issueReporterReportSpy;

    t.context.sandbox = sandbox;
});

test.afterEach.always((t: TestContext) => {
    t.context.sandbox.restore();
});

test.serial(`if a job doesn't exists in database, it should report an error and unlock the key`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves();
    const loggerErrorSpy = sandbox.spy(logger, 'error');

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }]);

    t.true(loggerErrorSpy.calledOnce);
    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.false(t.context.databaseJobUpdateStub.called);
});

test.serial(`if the job in the database has the status 'error', it should work as normal`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    t.context.job.status = JobStatus.error;
    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);
});

test.serial(`if the job status is 'started' and the job status is database 'pending', it should update the status and the started property`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);
    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.started);
    t.is(dbJob.started, data.started.started);
});

test.serial(`if the job status is 'started' and the job status in database is not 'pending', it should update just the started property`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    t.context.job.status = JobStatus.finished;
    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);
    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.finished);
    t.is(dbJob.started, data.started.started);
});

test.serial(`if the job status is 'started' and the property started in database is greater than the current one, it should update the started property`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    t.context.job.status = JobStatus.finished;
    t.context.job.started = new Date('2017-08-31T23:55:00.877Z');
    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);
    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.finished);
    t.is(dbJob.started, data.started.started);
});

test.serial(`if the job status is 'error', it should update the job in database properly`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.error }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);
    t.true(t.context.issueReporterReportSpy.called);
    t.is(t.context.issueReporterReportSpy.args[0][0].errorType, 'crash');
    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.not(dbJob.status, JobStatus.error);
    t.is(dbJob.finished, data.error.finished);
    t.deepEqual(dbJob.error[0], data.error.error);
});

test.serial(`if the job status is 'finished' and all hints are processed, it should update hints and send the status finished if there is no errors`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.finished }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);
    t.true(t.context.issueReporterReportSpy.called);
    t.falsy(t.context.issueReporterReportSpy.args[0][0].errorType);

    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.finished);
    t.is(dbJob.finished, data.finished.finished);

    for (const hint of dbJob.hints) {
        t.not(hint.status, HintStatus.pending);
    }
});

test.serial(`if the job status is 'finished' and all hints are processed, it should update hints and send the status error if there is a previous error in database`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    t.context.job.error = data.error.error;
    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.finished }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);

    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.error);
    t.is(dbJob.finished, data.finished.finished);

    for (const hint of dbJob.hints) {
        t.not(hint.status, HintStatus.pending);
    }
});

test.serial(`if the job status is 'finished' and all hints are processed, it should update hints and send the status error if there is any error`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.finishedWithError }]);

    t.true(t.context.databaseLockStub.calledOnce);
    t.true(t.context.databaseUnlockStub.calledOnce);
    t.true(t.context.databaseJobUpdateStub.called);

    const dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.error);
    t.is(dbJob.finished, data.finished.finished);

    for (const hint of dbJob.hints) {
        t.not(hint.status, HintStatus.pending);
    }
});

test.serial(`if the job status is 'finished' but they are partial results, it should update hints and just send the status finished when all the hints are processed`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }]);

    let dbJob: IJob = t.context.databaseJobUpdateStub.args[0][0];

    t.is(dbJob.status, JobStatus.started);
    t.is(dbJob.started, data.started.started);

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.finishedPart1 }]);

    dbJob = t.context.databaseJobUpdateStub.args[1][0];

    t.is(dbJob.status, JobStatus.started);

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.finishedPart2 }]);

    dbJob = t.context.databaseJobUpdateStub.args[2][0];

    t.is(dbJob.status, JobStatus.finished);
    t.truthy(dbJob.finished);

    t.is(t.context.databaseLockStub.callCount, 3);
    t.is(t.context.databaseUnlockStub.callCount, 3);
    t.is(t.context.databaseJobUpdateStub.callCount, 3);
});

test.serial(`if the job receive more than one message from the same id, it should lock the database just once`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }, { data: data.finishedPart1 }, { data: data.finishedPart2 }]);

    t.is(t.context.databaseLockStub.callCount, 1);
    t.is(t.context.databaseUnlockStub.callCount, 1);
    t.is(t.context.databaseJobUpdateStub.callCount, 1);
});

test.serial(`if the job receive two messages with different id, it should lock the database twice`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    sandbox.stub(database.job, 'get').resolves(t.context.job);

    await sync.run();

    await t.context.resultsQueueListenStub.args[0][0]([{ data: data.started }, { data: data.startedNewId }]);

    t.is(t.context.databaseLockStub.callCount, 2);
    t.is(t.context.databaseUnlockStub.callCount, 2);
    t.is(t.context.databaseJobUpdateStub.callCount, 2);
});
