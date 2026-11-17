// Fixed offline/default-extension candidate journey. Not native ownership proof.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync, appendFileSync, existsSync, lstatSync, mkdirSync as rawMkdirSync, readFileSync as rawReadFileSync, realpathSync, renameSync as rawRenameSync, writeFileSync as rawWriteFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep, delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { admitCandidate, aliasInvocation, assertNaturalResult, createFreshRoot, installationPaths, inventory as rawInventory, isolatedEnvironment, jsonFile as rawJsonFile, parseCandidateOptions, retainedRunner, runSteps, saveJson as rawSaveJson, sha256, verifyInstalled, verifyCmdShim, CandidateUncertainty, uncertainty, holdCandidateUncertainty } from './installed-candidate.mjs';
import { runCandidate } from './test-pack-candidate.mjs';

const mkdirSync = (...args) => piEvidence(() => rawMkdirSync(...args));
const renameSync = (...args) => piEvidence(() => rawRenameSync(...args));
const readFileSync = (...args) => piEvidence(() => rawReadFileSync(...args));
const writeFileSync = (...args) => piEvidence(() => rawWriteFileSync(...args));
const inventory = (...args) => piEvidence(() => rawInventory(...args));
const jsonFile = (...args) => piEvidence(() => rawJsonFile(...args));
const saveJson = (...args) => piEvidence(() => rawSaveJson(...args));
const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const skill = (name, marker) => `---\nname: ${name}\ndescription: ${marker}\n---\n# ${name}\n`;
const probeArgs = ['--no-session', '--offline', '--provider', 'bazframe-probe', '--model', 'probe', '--thinking', 'off'];
// Read in full: installed docs/rpc.md, rpc-mode.js, jsonl.js, rpc-client.js,
// examples/rpc-extension-ui.ts and rpc-demo.ts. The example client's timers,
// readline and kill paths are deliberately NOT reused. This pin is narrow:
// selected CLI imports this exact bundled implementation of the reviewed EOF
// -> await runtimeHost.dispose -> flushRawStdout -> process.exit(0) path.
export const reviewedRpc = {
  version: '0.84.4',
  files: {
    'dist/bundle/cli.js': '5406c369954516fb56879d685e082ff9095cd6e06e41af406f394942377fd4bf',
    'dist/bundle/chunks/chunk-OMWWHBTG.js': '08cbc4d2d6d3cafe995cf3c3a1a6fded7b07f07009101b6fee7cdce5daf8062d',
    'dist/modes/rpc/rpc-mode.js': 'e7e4724aa55c5aac73cf36793653b26736200e5c59d58373990fc31028f86477',
    'dist/modes/rpc/jsonl.js': '049a9f8ca4242c79f1911ed977949e8d8906b4561f424c2729687f426fabaacf',
    'docs/rpc.md': '010811d3526435b4fff5b03ee3a40f5bcb47fa17d5034fbd6b598955f56020d7'
  }
};
// 0.87 moves execution behind cli-runtime and a larger chunk graph. Pin every
// shipped bundle file plus the reviewed readable sources/docs; external runtime
// dependencies still require the complete installed-prefix admission.
export const reviewedRpc087 = {
  version: '0.87.0',
  files: {
    'dist/bundle/cli.js': 'e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774',
    'package.json': '9bb655451e850a8593ba87f563c26d3d2af2f503b76318e2f1bbe53eb28c9180',
    'dist/modes/rpc/rpc-mode.js': 'bdd94e753e6d19731d9fb9ea370462d095d64f1e78bddd7651320663fa57c4ff',
    'dist/modes/rpc/jsonl.js': '049a9f8ca4242c79f1911ed977949e8d8906b4561f424c2729687f426fabaacf',
    'dist/core/output-guard.js': 'e860db94650c57e07582c300983671737bf9e796682193b498f75e3dd72e9024',
    'dist/core/agent-session-runtime.js': '9a502461b1b1df3251b9bc41b786ddbc47413c9115957d6b091e3360a54073fe',
    'dist/core/agent-session.js': '5ebfae51db5a900596145159428e7cb57d195af9d54a28f41d4ac8ff1bfd5729',
    'dist/core/extensions/runner.js': '67c7ca2d24197ff46cb5f0a49d7c19a76825ab7c66bc942015a484b550396441',
    'dist/modes/print-mode.js': 'f2eb170b9620c1d37e68b788ff71257a4402a23e7f3999575feee8e5d9e13b3f',
    'dist/core/provider-composer.js': '96a55a81b11e0c834bd3cf5d13b3e4031bc4803e05f1f8120fb9325b2ad0242d',
    'dist/core/model-runtime.js': 'bae3c3feb7928c7702c3d98a3454660bee1647064dd449472fc6308c354fbc25',
    'docs/rpc.md': '15fcd26bee72777b373fd5f2edd77091a01cadd4de95e48b08422ced0552a28d',
    'docs/sdk.md': 'd3ae431453e8da71d38da833ad43713bca6d537af53e4e0f3ebaef87c14c6732',
    'docs/extensions.md': '6c5ad9dab2480a475ebfab840594202ea4c00870a86afa5e8eced905300872d2',
    'docs/custom-provider.md': '7a159f6fb8a6f96ac73e38ab6756206701a5ec87c5dddd92f610182e09cd4d4f',
    'dist/bundle/chunks/anthropic-messages-MYU5ZMRF.js': '8ea6613976232f60860e433283ebd9c2cc1bcdd2884544c68fefedd8f00d17dc',
    'dist/bundle/chunks/azure-openai-responses-HUSQ3GP2.js': '426fd91f4f1bbfaea2500779d983fc2d30cf04c64a1a40a9bb96011abe38cacf',
    'dist/bundle/chunks/chunk-4DKZACXI.js': '2b60c86e356ef338ab1cea32b63f8f01e8d8d3bb7f14342fcc876a8d9a8b5505',
    'dist/bundle/chunks/chunk-4L3WN2XY.js': '5c4604c708bc66bb13fc9da56a8f77743947e6da546dcb33f25c48fbe30e66ce',
    'dist/bundle/chunks/chunk-6CYCI3EJ.js': '374d74dce657072c93af51815bab77ef9d3740b7edbc1360bf61dc625cf07ff0',
    'dist/bundle/chunks/chunk-6R7UI4IY.js': 'e89ad86eec743cbab9d369278be780acb9bd85176a36c19123a964ced4472d9c',
    'dist/bundle/chunks/chunk-7ZC4UXSL.js': 'c5057baea590a53e2534934d8d86fe358705859839f9e393f1482442593f41d2',
    'dist/bundle/chunks/chunk-A3JYRWB6.js': '39a18bfbaf6a8edd098844da7988e1ff4a5551520e47c4aacbfc95e7c669a843',
    'dist/bundle/chunks/chunk-DRQDKNXA.js': '11ac5590249b6a36aa81cf4b6c0f7be3a354298f13416e8cffb27a6c245f19dd',
    'dist/bundle/chunks/chunk-DTD7JQ7Y.js': '05967ed5dee66cf7f3fe0f8bce1426131021f03d1d6163761a94a8ddd88180be',
    'dist/bundle/chunks/chunk-FUXEF6JQ.js': 'b7d0697d0f4c7d3b54c6aee545d3b27c5981c27d0470e1c79876898f28f2c472',
    'dist/bundle/chunks/chunk-GV2E3GBU.js': 'c048c53af0a66474912293c0d42985de242a2579c5dd22f91d181e862f208b93',
    'dist/bundle/chunks/chunk-L2ZPNLYD.js': 'eeac72dce2d349ec26278d12cfc96e666a165e85fd4132a9fb1cdd2b8a893e3f',
    'dist/bundle/chunks/chunk-NUHFSC37.js': '9b724435ac1da15eaa4465e7eaca0aa9a23617c6f1efa7b6261db6d17dbe755b',
    'dist/bundle/chunks/chunk-PGXDEOVV.js': 'b6187ec855046de0f97de34bc7f4ad8057e9b9d51ff057f65acf6432d2373f37',
    'dist/bundle/chunks/chunk-PJACZCIR.js': '5aaa7984c9ef7e2db07b44323b0e21660926302599b1e76820a538a1d7ae538b',
    'dist/bundle/chunks/chunk-PRRNXB7S.js': '87fdebf0992e87432f8bfb873e901cdc8eb2b473c5da3444650ef6d933f5f232',
    'dist/bundle/chunks/chunk-RCZIEVGO.js': '7b2c0b36b01c1cedb11e7ab525a3fade0967f56b0cbd286fc32ffa25f5965055',
    'dist/bundle/chunks/chunk-S7SZN6Z3.js': 'e3c80297855f99bfa89f5806d29b3f2a85780c57647802d61d4615daa26f2a39',
    'dist/bundle/chunks/chunk-TEPMHNKQ.js': 'ad6967e374788a68cb111fdc1b8acfed81acbd177bda714f6f2e8dd1aa4708de',
    'dist/bundle/chunks/chunk-TRDNDS6A.js': 'e2a811eb2c48e810da1091f9bf14137b7e966185fa721e4b9fd3b6c34d577bb4',
    'dist/bundle/chunks/chunk-USJZMAIR.js': 'a955b5a2c31941b424157fed43dbbfd8dcc335937bdeff80f6da110043cbc849',
    'dist/bundle/chunks/chunk-WIUZI2CJ.js': 'a85d542043c502be8f1c204929762774b5373fae0f3a21b918bf2df151a1edb8',
    'dist/bundle/chunks/chunk-XDUWOHPL.js': 'e5b0817b6f80bfb3d171e65bf7a959002ed85de16e8d5a6a895fe9fb0cc07e0d',
    'dist/bundle/chunks/chunk-XNGRGP62.js': '765fb220045956695bf1b1be6cd11c1e12a39b8e548d0e2f5e879ab5ae119de6',
    'dist/bundle/chunks/google-generative-ai-IMS5EK2Y.js': '075e745faaeed61ea2ef0350b0227cc1983232a3289ad8be830350ad85c38cb6',
    'dist/bundle/chunks/google-vertex-O4YJEQUW.js': '10c917f7884cb7d97b1e0945f646480bfdc461ca465e6761458cbecead1ffd2e',
    'dist/bundle/chunks/https-proxy-agent-2VXB7436.js': 'e978e6388d451ea857e46c482286da56a71b06951dbf10d7ccd2fc064e5e955e',
    'dist/bundle/chunks/image-resize-worker.js': '302cecd5e835bf61baf2152e375483a8ef1192897f4c29696c8161e0e72c6b6d',
    'dist/bundle/chunks/jiti-loader-C3NU2SDH.js': 'aee404df8dd95be19248cacbaa1954c4bb8b8d13b1f02e6516a3f527f5dc1d05',
    'dist/bundle/chunks/jiti-static-loader-E6ANQD5T.js': '2a489103aae8f0f6f8a2a72ed50e8afd1e953223e71bfbae325b7c7321145a4b',
    'dist/bundle/chunks/lib-HGQMNYVT.js': '1459b7c62841922dfbcc378f87c3b9ae29ecd9f6a64bab6a931a0fc381fd2f24',
    'dist/bundle/chunks/mistral-conversations-NOSQHBEY.js': '4ded3bf33972ed9b26e34450f7186800c4af739ea467932f50e1c6d8916a9923',
    'dist/bundle/chunks/multipart-parser-SQ6GDJL7.js': 'aeebcd36c1ac2f9136763b6537b81ae3b1a689af2e0427489bc54b9d922ad198',
    'dist/bundle/chunks/node-O3RIBJRH.js': '05ab46bc6a583f688ddbc21fa2a4af8e7b215a6bdf10e269d6c2236c74b2e81e',
    'dist/bundle/chunks/node-TWVVAGPO.js': '6a3e3765864bc2d0d7df27e644e78399db9047299a1f6a99d7cc07082df1c4a1',
    'dist/bundle/chunks/openai-codex-responses-QDSOTBBO.js': 'cec5815a36e82be42749ba6691e0b3d444bed940776b484f2fa26da22abe979b',
    'dist/bundle/chunks/openai-completions-XHML6MTL.js': '57338d24aeda8de86c79fc876c2d9509ed67e848aa400d024de5e297017762fb',
    'dist/bundle/chunks/openai-responses-HWEUZ6WZ.js': '4ebfa8cec003119c431c92b8306f28f5b9359bde82e213bc8afa6ed764d5bde8',
    'dist/bundle/chunks/openrouter-images-N4XVVFSD.js': 'd8f71c8cd1575e6d6514393db63c2964b83b3a9c12bf0c5d72224f74d6f7d8ae',
    'dist/bundle/chunks/pi-messages-GFKBWJHZ.js': 'dd913faee187e41c870260003073bb975b89bac07dd65d2694f5708f3d1f500e',
    'dist/bundle/chunks/src-UK77SYZE.js': '9aa94a3a30ca9ea03559d6aaad7dda3a492b468f13c6b184e48abd64c365b9db',
    'dist/bundle/chunks/virtual-modules-BNWPZYDH.js': '8e7047d44ca6ee9f429c12d68a7419ed940b89a53c402138465b7b41f49fe05c',
    'dist/bundle/cli-runtime.js': 'afaec240d4a30b956abdb2540500176c2da469993c859143b8e61a0c3773ccf6',
    'dist/bundle/rpc-entry.js': 'fa3130f0266ea53aaee4bbbe70e719b21b719a339738b97626dc84949ee94f1c',
    'dist/bundle/index.js': 'c65d4cba6174dbb64b7be5c9fa47f667d5ddae3b4d8f3df665c5aa1d0274696e',
    'dist/bundle/chunks/kimi-coding.js': '54995243fc82f2f9386268572efdfa088da4b51062e1950bacf6c81bbeaecfc5',
    'dist/bundle/chunks/github-copilot.js': 'b33ea134303ad479f8bfa039ed93edc655d91b3a75bcf9f8d7fb2b7034fcc429',
    'dist/bundle/chunks/openrouter.js': '8bbffe5611f72f9bc1d7a6a134f5d32c23434aa76ff5656acac813c77a31aa5a',
    'dist/bundle/chunks/bedrock-converse-stream.js': 'b9d27adf1335ab7956373e8070a2d15777729ebcae552b9cf51c6f3955a45f61',
    'dist/bundle/chunks/meta.js': 'be6e51c01f80832a41c861613cbe6cebef5a4982887d1f252c07620778cea0aa',
    'dist/bundle/chunks/radius.js': '8fb7e9fd952364b9415adca6e1c1b57fd5a931a106fa1a08fccdb936f78d6850',
    'dist/bundle/chunks/anthropic.js': '0d5ca2e2c170b80f924e8d2f6f713ab87027f8c2410c24b1b33b4dec02c82800',
    'dist/bundle/chunks/xai.js': '1551bf9d2db9fec7be60b87c72e5b6b7163c828c1e39adfff31b146374332d9b',
    'dist/bundle/chunks/openai-codex.js': '2c0190771ae21bb4f5618195f5c47d93b2d2b6b0284a3097bb91b8cdf4939c23'
  }
};
// 1.5.2: reviewed CLI bootstrap -> main -> RPC/session/provider/extension path,
// including handled/queued preflight and awaited EOF disposal/credential flush.
// All shipped bundle bytes are pinned (not a claim of semantic review of every
// unrelated provider/tool, nor external dependency closure: the executed bundled
// static loader still requires external jiti). Readable equivalents, declarations
// and split protocol docs below bind that narrow review surface.
export const reviewedRpc152 = {
  version: '1.5.2',
  files: {
    'package.json': '18b422b7d80f2caa2551d253c0a8409e1caa54b954bfb7d18252e507bb8a0318',
    'dist/bundle/chunks/anthropic-messages-CA3HHOL3.js': '27b739793dfc3a97c7608066775a413c84288b6399aebdfb9ce301d6633cb981',
    'dist/bundle/chunks/anthropic.js': 'f76fb47980e8fd82a13fc356e420a9a2f554bba0fefd4eb3f5d97812583309a8',
    'dist/bundle/chunks/azure-openai-responses-76TWS6DT.js': 'd428a7568baf0f3537ad20a275a013f143498d2c35de844f81c7846375ef0de5',
    'dist/bundle/chunks/bedrock-converse-stream.js': '289ad2696b8028516ef09f5386fbccfc27d68e48c0df615f3c24ede7c229fe52',
    'dist/bundle/chunks/chunk-36QC74V4.js': '9d0bfdc1eaca5abb8f1796fdb9b256e981f7d429e99ce3aa3b9492fca7d1b5d0',
    'dist/bundle/chunks/chunk-4KSTFUIK.js': '474ef4df04023a4b1cd177f1f7a9722a9c78929bbdd8fb98aa26d2ccc286d697',
    'dist/bundle/chunks/chunk-4UNPP53I.js': '5e3e508ec380139b1c5e917a9bae4bc90726d18282ae8ee2a331b4f1293bfe2f',
    'dist/bundle/chunks/chunk-5AGIVGSV.js': '5c90a831ae8d5f5aa8e66e2fa3c76b5e2f6046df80429172654385d23c6c9b73',
    'dist/bundle/chunks/chunk-6QGV3IWD.js': '8849fd570c6155bcea2df8962b65e6b1b01ed88c5c25a1b29fba535ca07df35a',
    'dist/bundle/chunks/chunk-7CBJINYJ.js': 'ba573c7e16ac49ca552f399dee4476b7bdc255212fd9a4bfda632158d1f37ef6',
    'dist/bundle/chunks/chunk-7DDKXS2Q.js': 'b5c1320c3a3648f71ce27577893cb1a538f139dc86f23c8f2669f576478175dc',
    'dist/bundle/chunks/chunk-7ZC4UXSL.js': 'c5057baea590a53e2534934d8d86fe358705859839f9e393f1482442593f41d2',
    'dist/bundle/chunks/chunk-AUUCDC7R.js': '3b24d90a43208a08f12b6f15fc669916db6b191d71d769957d603c755489f953',
    'dist/bundle/chunks/chunk-BAC3QPNW.js': '76b671f227dec9a5c594a5832c4d8bb830cddd5fc24a58c48bca15c0abaa10c8',
    'dist/bundle/chunks/chunk-CF5GWZHW.js': '7f9318ab1ffb8790307f100b13710731d409147788ceca33f4a1eed223f17454',
    'dist/bundle/chunks/chunk-FF6XOTWB.js': '2d833946ea799edfd5c1d44fa33474370ab4d4f152d5ae189dd465dc51982958',
    'dist/bundle/chunks/chunk-FFMDRXC4.js': 'cbc3f54b5179a1ce8c4608e06cb8da72463a9ed378713e6a6d455c2fc23081ac',
    'dist/bundle/chunks/chunk-FMPAMX2W.js': '4378273f622a17f18ed6db86b71204186109b39afeaee00e34bfa5684bdb21c0',
    'dist/bundle/chunks/chunk-GFUN2N5K.js': '57eed07f60cbc0dad6687aa4cc61104d39a0aec1baa1fc6fe798af80bcfb8770',
    'dist/bundle/chunks/chunk-IEBK4HQA.js': '6167a1ed49cb3d62d754218b4e4cef61e0809105404cbad5760b9ef126547d1e',
    'dist/bundle/chunks/chunk-IQUU5XIT.js': 'd51cfd6a78213e040c76d37f22b7e808fd6b8ae1db909423b8894772d72d33c3',
    'dist/bundle/chunks/chunk-JXWJOIH4.js': '2857397f268829d29c5b22ff366e723ba9c98f2a13fc290ff64ffe921ba1686a',
    'dist/bundle/chunks/chunk-L2ZPNLYD.js': 'eeac72dce2d349ec26278d12cfc96e666a165e85fd4132a9fb1cdd2b8a893e3f',
    'dist/bundle/chunks/chunk-LPXNMA2W.js': '82078b13cabe692e5bb3495c1d1c2bd29b9290a1e5a4065234c507f4b668a8d9',
    'dist/bundle/chunks/chunk-LQLJ7CDW.js': '226fb3ac164d9f83ada8722c770c7bbfc87b8e54175adbf0994281056a45b8ac',
    'dist/bundle/chunks/chunk-LVVZS2NO.js': '536c349d1d8fcc0c0e550fde15978b1db87b45e9cc0ef23b035a485d4b8270f3',
    'dist/bundle/chunks/chunk-MMDXLZVS.js': '5d39160a8fa58d199ae1042b51667ca37e9dd70c6bc96f98509909dc31a4d28f',
    'dist/bundle/chunks/chunk-P7FPUEYA.js': '5e6e981a9554b58c73b7a586c8ef8916f503fb022fff32a9d0b2a318e9089b19',
    'dist/bundle/chunks/chunk-PGXDEOVV.js': 'b6187ec855046de0f97de34bc7f4ad8057e9b9d51ff057f65acf6432d2373f37',
    'dist/bundle/chunks/chunk-PJACZCIR.js': '5aaa7984c9ef7e2db07b44323b0e21660926302599b1e76820a538a1d7ae538b',
    'dist/bundle/chunks/chunk-PMRZO46Y.js': '9e0921ff9785b4ab3c1e0d8d00feb9cea6a6d2b0936b7a0ac7e9d7b0a0e9f58d',
    'dist/bundle/chunks/chunk-PRRNXB7S.js': '87fdebf0992e87432f8bfb873e901cdc8eb2b473c5da3444650ef6d933f5f232',
    'dist/bundle/chunks/chunk-QN4TOIZN.js': 'ab9e2b88dfa5d94928ae84cfe88afec2314fcf393bc08b9456fe239d2ee9df0e',
    'dist/bundle/chunks/chunk-RDZVAGPR.js': '657242b8d4b3ab52369ceaf5374ea7e9da241cb64752142855eb99f32be7de81',
    'dist/bundle/chunks/chunk-RKNK4Y6L.js': 'e8b46a5523f759714a45251c9764fb0f12656bdb702e010ec1fa8ecd42381a05',
    'dist/bundle/chunks/chunk-TMTOQ7H7.js': '23eb2a77f71ee7e42cba6f9cf7557f8f8f2f80c9f3deb5d2ecd6d34bdb2aa5a3',
    'dist/bundle/chunks/chunk-UTB4DTYQ.js': '956609841588139d975e018004d520ce4eee345fde5f948239a9f72a748fa91c',
    'dist/bundle/chunks/chunk-V7SLUK6A.js': '09b8f392507f2daa951a22cf7e021549278b4f93e806b8150458319aaf60cd37',
    'dist/bundle/chunks/chunk-VEJDBY3O.js': 'effbbd5d6247983dc11c7ae5796eb24bda88f9ebf78c707d3f92ca73cbb8b51e',
    'dist/bundle/chunks/chunk-VKJQ6CME.js': 'e3d7ba248555c17c0e03d2afec10e76117307e4bc1626b46f62186b4f3ed5ae4',
    'dist/bundle/chunks/chunk-WL4TUXY7.js': '9055cc722dfb34d79df15b660a475e94f88ed8c0999b306b05b60841269282dd',
    'dist/bundle/chunks/chunk-Y55SJART.js': 'a89fabee8d170ff09ed3e3c0354eb56e72384a1e142fa08e5686975cbbdbf3e1',
    'dist/bundle/chunks/chunk-ZBIZYD6W.js': '57ffeeadcb8c2d8b71e97995a6a202ff6713071d4a264507fe599a6c6c4c82f5',
    'dist/bundle/chunks/chunk-ZG74NES2.js': '75791fb8ea55039975147e848a7785c930a5a21dae79c3a2eb1120513fdf4de7',
    'dist/bundle/chunks/chunk-ZGYS4UTC.js': '4a5b16927aa23173cd4598cfbb51ce4b8c0512f0d36ee055d3ada5e0f551e8c0',
    'dist/bundle/chunks/cli-7RHMDOHL.js': 'faeca29201aa88a01af918f00e3afa8aef58851d8ac06a058647cd28cc058263',
    'dist/bundle/chunks/cloudflare-workers-ai-system-one-U4J7D646.js': 'f79e1390ee2d844f78cd20b21da50c153d49acd2b2a014ec252eccbc9caf68c4',
    'dist/bundle/chunks/codemode-worker.js': 'e68f1da328891a985d6fbf6db72094688b4d8d0a1ea732e39a84a03e326b357a',
    'dist/bundle/chunks/easter-egg-3d-GEVPKQF6.js': '6a583fe682b4db91911e67e26bf25573cbe776e117c74a4d1cdd291a2e98b28e',
    'dist/bundle/chunks/execute-L2EEDV3L.js': '21decb679406682a3d810502dd154f77a0d8bcb3f6757aa603af87366396d8a5',
    'dist/bundle/chunks/github-copilot.js': 'dbded573eacd4a8d7ac601524beee96f9017ec1e1c7e688ebabcf8f692dc89bc',
    'dist/bundle/chunks/google-generative-ai-D5B6W47J.js': '648ae98b9728c783257ddf3d4f1a0642dcdfaf010e1b3f71f0faa636b2a17fe6',
    'dist/bundle/chunks/google-vertex-U4H5YDEW.js': '86f2bfbe0717a7889a178559bc50e8130515382bab24d6caf0f7207af1ce33eb',
    'dist/bundle/chunks/https-proxy-agent-LVOO5TPL.js': '6d2593a18653f9f6dfd06af44a9fce0a254981c5fe273f56691f8a7858cecdbc',
    'dist/bundle/chunks/image-resize-worker.js': '554367f8f1877b669efed456fcc07f7304a2fe80a89889e23d6ca119f859cac0',
    'dist/bundle/chunks/jiti-loader-GL4HJFAD.js': 'be2d0f1bb460e726bf4e1df1c0d20955f673f1ffa192435fd65440aa6073f38f',
    'dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js': '5e088689059655c592551fac8376f9bb9eef58d00b903a07260a8d13e62ed17c',
    'dist/bundle/chunks/kimi-coding.js': '92615955d9595dec134dcc1f0906c0fb155014c22664eb339d1a1957a337292c',
    'dist/bundle/chunks/lib-4AVRLBHM.js': '1ada30d2ddabb60ad5f86e95d7a13d7826ae737a81e8ad2da5efe90994f18c3a',
    'dist/bundle/chunks/llama-cpp-classify-EJXCQRUQ.js': '9677fcc8411b01c5e629f9971e2bed4199a460615c8e34f3963edf6783f93ae7',
    'dist/bundle/chunks/meta.js': '0bf7dd14521e13e6b3cc594aca9b4522bf8f3590691d093fce850cc0c62b7b39',
    'dist/bundle/chunks/mistral-conversations-S277EKLB.js': '80e824225d20f57475b5efa58b658775b10e13f5de6eaa84651fa3afa8b85b96',
    'dist/bundle/chunks/multipart-parser-FMGQ7342.js': '73e0ee9663313882b6146146d8fe18ca677115bb8bd1ca4a8c37aba65bc7308a',
    'dist/bundle/chunks/node-AUOGOBCN.js': '6f5759eda9ea48b430e4c41d59e36d8e27a8b860fa392f82943b44e1feaa47b4',
    'dist/bundle/chunks/node-KCMANYC2.js': '755da427e754c8fff14d7486e36fac29e9c20f777c72d5a648e46d71ebc62c53',
    'dist/bundle/chunks/openai-chatgpt.js': '47a5c6b7d31ccbd99c407d388f0453272514219770f1f0e89de3ef0211c70136',
    'dist/bundle/chunks/openai-codex-responses-TEQRB65N.js': '0165f251129fd7a63ada4dc300591458d63fefc30ed9682f7f268ebba5bdbbe9',
    'dist/bundle/chunks/openai-codex.js': 'c52c5a3ff9088bcbf38e46399f079512d2693f91afc22d6038289dc15d82693d',
    'dist/bundle/chunks/openai-completions-HRZOSLBO.js': 'cb2da018bad7b2b259092498e9935e6da7117b09ea7db3cad8ea1351ad01207a',
    'dist/bundle/chunks/openai-decisions-F66BDLOM.js': '6e7f96802788e8fb3ac5569c46f59bff07b8d17f65ede5eda06fb84c9bb93d25',
    'dist/bundle/chunks/openai-responses-BAKFWTGE.js': 'dc1f98915bd7d3fc8eee9454315c8817626868a7c7332e05d320fd963854521f',
    'dist/bundle/chunks/openrouter-images-VXF5TVIK.js': '6c5816621ed018c5db48f6422fb7ffe1a10c2cffdad37b7da82c41e6a8cbea56',
    'dist/bundle/chunks/openrouter.js': '53a48b9b030a46029f2e0f185cbc01fa43cb88ba6f5f357745e28579a2d87aa6',
    'dist/bundle/chunks/pi-messages-UBJKNDRN.js': '853e7ded02dc0edd0fc359fcb0d0638d4ffeac2cbb7972b214cb33102e9d2cbd',
    'dist/bundle/chunks/radius.js': '25b3334da1619c0a6766a35a2096514c66bc2c019efb34b8d0ce18e72ceeaade',
    'dist/bundle/chunks/runtime-J5ZSBGTX.js': '21e6b790ae222c4e8bac24fd0e08dc1966c779b6b5241d9ab55d077438f999d8',
    'dist/bundle/chunks/src-QKGKDFSU.js': '78f9cd0e05f671111ec9d1722d7b7551864c3bd58c8f025d5c305495f288aa42',
    'dist/bundle/chunks/typesafe-system-one-56TEMIHL.js': '0b1d137fb302655239717ec0f4b202ca4d26a3df034fbf64ca198eb7c8a3d537',
    'dist/bundle/chunks/virtual-modules-KITQRTYM.js': '769f37946eb78524c2c2066a1057506602dd0377331e8ad1fc56d7d0ef4f174a',
    'dist/bundle/chunks/xai.js': '1551bf9d2db9fec7be60b87c72e5b6b7163c828c1e39adfff31b146374332d9b',
    'dist/bundle/cli-runtime.js': '8fdd4161be64f4aadb8bec47ae77b56dcbeab288da6e55dcab3e0243e50f80fc',
    'dist/bundle/cli.js': 'e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774',
    'dist/bundle/index.js': '90a5b99054119815bb73e9b95210e4b3e45ddc0895fe16458cc3d808ea31d706',
    'dist/bundle/rpc-entry.js': '790ab617fafc044f7c13922f838906e90cd75eb1c19c0889efce441804564550',
    'dist/main.js': '29d5564f1a397eeb8a9c771b8e42c4fb88420e676bddbd096854a3ad84f4d49e',
    'dist/modes/rpc/rpc-mode.js': '505297dba2df1de3003c0399b3312fd581359a4e27a5e9262b274b6cb5cb4ef3',
    'dist/modes/rpc/jsonl.js': '049a9f8ca4242c79f1911ed977949e8d8906b4561f424c2729687f426fabaacf',
    'dist/modes/rpc/rpc-types.d.ts': '68b6dc2e47a3969c09c961a40d0462473407b6786f3bd02715fa035e816e2af1',
    'dist/modes/json-event.js': '5f3756470739fa4a1595feeaf1ce2dfd29e36a2cffd9e642f914fc23f540d606',
    'dist/modes/print-mode.js': 'd299d32642059b61e040e4da815f6d47e2db35f8b2a2f2d8b3e2103c0260ce78',
    'dist/core/output-guard.js': 'e860db94650c57e07582c300983671737bf9e796682193b498f75e3dd72e9024',
    'dist/core/agent-session-runtime.js': '44beede45451cef172d7137077e7e84867b9aaa9f20575143fb9a93fcc00261a',
    'dist/core/agent-session.js': 'ee756f6f74afe9f8930ebf216c95334605d913a275a0eec2c9702f101baef3c3',
    'dist/core/agent-session.d.ts': '56d24887a400d77a77b428deb1cce25576cac27e18089e722f536d600fa32c3a',
    'dist/core/agent-session-services.js': '20b7aa4b0657b53fb522ea051df26f72901802e03cc06c89e0a8926388bca601',
    'dist/core/provider-composer.js': '98facdd61bdb741804f8f303c5b2661db7f40b64a8ec0ef4767df0d71ec03608',
    'dist/core/model-runtime.js': 'b17018cb70007a194f10b2aaf5ec3631329db20cf853ddc9ce4088e6b4373ab1',
    'dist/core/extensions/loader.js': '55e794b969dd4692a553b21767fe876537fe06083586816f62848e76c553ef7c',
    'dist/core/extensions/runner.js': 'dc7fc776198ec315feecbc8fd5d471453271a3dbf4b1a6a41df342253759a191',
    'dist/core/extensions/types.d.ts': 'ac8610b705f18c95f2efb8665293cbca0f6efaa6c000f4247a3b965022d46b3f',
    'dist/core/extensions/pi-ai-extension-view.js': 'dd44b3076d4ca95193e7c985b6f210c4170f22715e42ba8a4916e4fd5f8d0125',
    'dist/core/extensions/virtual-modules.js': '941f8647becc71fd241eac0fb19d3206f38f055f85721e5215a8473832d42f5a',
    'dist/core/system-prompt.js': '5f68e89c31ba3d4d1af8ad2bfd0c7c548879d47ee6ab4aabee50a826100da32c',
    'docs/rpc.md': '54e29df00e080c962df4fbb516dc441a9ce6805287bea61d45f3c99f92078446',
    'docs/rpc-commands.md': '4deeee367852f4633ef594bc079f9e9fb14640a4e3ba8a69b7c89b6f54740838',
    'docs/rpc-extension-ui.md': '3c6f2c6edfc8b1ace6642343727aef97a7e9234c85509850921b52d6ff09a48e',
    'docs/message-types.md': '78bb9c295e88948c9bdb23e7c75a66a0e2703601c48d731fda01d24664dcf63a',
    'docs/custom-provider.md': '78e01e866af7969e2d8e70937988bc0fb7b4a2a43bc25aab665c3549e169971f',
    'docs/extensions.md': 'd59f4ded8e49275120c8379dbeabb847267efd36e15fc21f6189026d0fbf8f22',
    'docs/cli.md': 'd3b719dafaa11c93841059eb02d0167403e26a19d8845ca54aad3443c58952fc',
    'docs/sdk.md': 'd9034ccbf2219a58712d8dd4fcdf47e687d77131e71dd5d119d8a71e9bd2a2e8'
  }
};
export function bindRpcLifetime(pi) {
  const reviewed = [reviewedRpc, reviewedRpc087, reviewedRpc152].find(binding => binding.version === pi.version);
  assert(reviewed, 'Selected Pi needs its own reviewed EOF lifetime binding');
  const root = dirname(pi.manifest);
  assert.equal(pi.binPaths.pi, join(root, 'dist/bundle/cli.js'), 'Unreviewed Pi entrypoint');
  for (const [name, hash] of Object.entries(reviewed.files)) assert.equal(sha256(readFileSync(join(root, name))), hash, `Unreviewed RPC bytes: ${name}`);
  return { version: pi.version, root, files: reviewed.files, shutdown: 'EOF only after correlated idle; no descendant claim' };
}

// Fixed four-cell layout; labels stay descriptive in receipts. The product's
// canonical and private owner sockets both use 22-byte basenames. Admit every
// possible cell BEFORE root creation/npm, not after installation has effects.
export function piCellPaths(root, platform = process.platform) {
  return ['0', '1', '2', '3'].map(id => {
    const cell = join(root, id), home = join(cell, 'home');
    const sockets = ['x'.repeat(22), `.o-${'x'.repeat(19)}`].map(name => join(home, 'profile-publishing', 'operation-locks', name));
    const maximumBytes = platform === 'darwin' ? 103 : 107;
    if (platform !== 'win32') for (const path of sockets) assert(Buffer.byteLength(path) <= maximumBytes, `Derived operation socket exceeds ${maximumBytes} bytes: ${path}`);
    return { id, root: cell, sockets, maximumBytes: platform === 'win32' ? null : maximumBytes };
  });
}

// Only the literal Git needed by this journey, not a general executable resolver.
export function bindSelectedGit(git, env, platform = process.platform) {
  const selected = realpathSync(git);
  const bytes = readFileSync(selected);
  const signature = bytes.subarray(0, 4).toString('hex');
  assert(platform === 'win32' ? bytes.subarray(0, 2).toString() === 'MZ' : ['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf'].includes(signature), 'Git must be an admitted native program, not a wrapper');
  const name = platform === 'win32' ? 'git.exe' : 'git';
  let effective;
  for (const directory of env.PATH.split(platform === 'win32' ? ';' : ':')) {
    assert(isAbsolute(directory), 'Git search requires explicit absolute PATH directories');
    const path = join(directory, name);
    try { if (!statSync(path).isFile()) continue; accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) continue; throw error; }
    effective = realpathSync(path); break;
  }
  assert.equal(effective, selected, 'Selected Git differs from effective bare git');
  if (platform === 'win32') assert.equal(env.BAZFRAME_GIT_COMMAND, selected, 'Native policy discovery must select the admitted Git');
  return { path: selected, sha256: sha256(bytes), effectiveBareGit: effective, PATH: env.PATH, nativeOverride: env.BAZFRAME_GIT_COMMAND ?? null, scope: 'Selected executable identity; dependent Git runtime/native ownership requires external admission' };
}

export function verifyAdapter(c, platform = process.platform) {
  const extension = join(c.env.PI_CODING_AGENT_DIR, 'extensions', 'bazframe.ts');
  const physical = path => { assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Expected physical adapter input: ${path}`); return readFileSync(path); };
  const template = physical(join(c.packageRoot, 'artifacts', 'pi', 'bazframe.ts'));
  const packageBytes = physical(join(c.packageRoot, 'package.json')), manifest = JSON.parse(packageBytes);
  assert.equal(manifest.name, 'bazframe');
  let desired = template, runtime;
  if (platform === 'win32') {
    const path = join(c.env.PI_CODING_AGENT_DIR, 'bazframe', 'runtime.json');
    const binding = { schemaVersion: 1, bazframeVersion: manifest.version, packageRoot: c.packageRoot, packageSha256: sha256(packageBytes), runtimeSha256: sha256(physical(join(c.packageRoot, 'dist', 'application', 'win32-application-services.js'))), nativeSha256: sha256(physical(join(c.packageRoot, 'artifacts', 'native', 'win32-x64-msvc', 'bazframe-win32.node'))) };
    const source = new TextDecoder('utf-8', { fatal: true }).decode(template), marker = 'const WINDOWS_INSTALL_REFERENCE = null;';
    assert.equal(source.split(marker).length, 2, 'Unique documented installer binding marker required');
    desired = Buffer.from(source.replace(marker, `const WINDOWS_INSTALL_REFERENCE = ${JSON.stringify({ path, binding })};`));
    runtime = physical(path); assert.deepEqual(runtime, Buffer.from(`${JSON.stringify(binding, null, 2)}\n`), 'Installed runtime binding differs');
  }
  const installed = physical(extension);
  assert.deepEqual(installed, desired, 'Unaltered installer-produced extension required');
  const ownership = physical(join(c.home, 'adapters', 'pi.json'));
  assert.deepEqual(JSON.parse(ownership), { schemaVersion: 1, adapter: 'pi', bazframeVersion: manifest.version, installedPath: extension, artifactSha256: sha256(installed), artifactBytes: installed.length }, 'Installed adapter ownership manifest differs');
  return { extension: sha256(installed), manifest: sha256(ownership), runtime: runtime ? sha256(runtime) : null };
}

// Omit --pi-version for ordinary dependency resolution; --pi-version 0.84.4 is
// the explicit minimum matrix cell. Other reviewed pins require separate cells.
export function parsePiOptions(argv) {
  const common = [], extra = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (['--pi-launch', '--git', '--pi-version'].includes(argv[i])) {
      assert(argv[i + 1] && !extra[argv[i]], 'Missing or duplicate Pi option'); extra[argv[i]] = argv[i + 1];
    } else common.push(argv[i], argv[i + 1]);
  }
  const options = parseCandidateOptions(common);
  assert.equal(options.batch, 'all', 'Pi candidate mode has one fixed --batch all journey');
  assert(!options.zip, 'Pi journey generates its own reviewed task-only export; external ZIP belongs to pack mode');
  assert(['direct', 'shim', 'both'].includes(extra['--pi-launch']), 'Required: --pi-launch direct|shim|both');
  assert(extra['--git'] && isAbsolute(extra['--git']), 'Required absolute --git executable for policy discovery');
  assert(extra['--pi-version'] === undefined || [reviewedRpc, reviewedRpc087, reviewedRpc152].some(binding => binding.version === extra['--pi-version']), 'Unreviewed explicit Pi version');
  return { options, common, launch: extra['--pi-launch'], git: extra['--git'], piVersion: extra['--pi-version'] };
}

// Resolve only genuine generated Pi shims, including a transitive dependency's
// nested .bin. A missing global Pi shim is a not-run alias cell, never a personal
// PATH fallback and never a direct-Node invocation mislabeled as a shell alias.
export function piLaunches(pi, paths, selection, platform = process.platform) {
  const result = [];
  if (selection !== 'shim') result.push({ kind: 'direct-node-installed-program', file: process.execPath, prefix: [pi.binPaths.pi] });
  if (selection !== 'direct') {
    const suffix = platform === 'win32' ? '.cmd' : '';
    const candidates = [...new Set([join(paths.bin, `pi${suffix}`), join(paths.packageRoot, 'node_modules', '.bin', `pi${suffix}`)])];
    const path = candidates.find(path => existsSync(path));
    if (!path) result.push({ kind: 'genuine-pi-shim', status: 'not-run', reason: 'No generated Pi shim in selected installation', candidates });
    else {
      if (platform !== 'win32') assert.equal(realpathSync(path), realpathSync(pi.binPaths.pi), 'Pi shim resolves outside selected Pi');
      else {
        assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
        verifyCmdShim(path, pi.binPaths.pi);
        assert(!existsSync(join(dirname(path), 'node.exe')), 'Shim-local Node shadows selected Node');
      }
      result.push({ kind: 'genuine-pi-shim', file: path, sha256: sha256(readFileSync(path)), prefix: [] });
    }
  }
  return result;
}
export function piInvocation(launch, args, env) {
  return piEvidence(() => {
  if (launch.kind === 'direct-node-installed-program') return { file: launch.file, args: [...launch.prefix, ...args], options: { shell: false } };
  assert.equal(sha256(readFileSync(launch.file)), launch.sha256, 'Pi shim changed');
  return aliasInvocation(launch.file, args, process.platform, env.ComSpec);
  });
}

// LF-only incremental framing; UTF-8 split chunks and U+2028/U+2029 are payload.
export function jsonlDecoder(accept) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  return {
    push(bytes) { return piEvidence(() => { buffer += decoder.write(bytes); let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); assert(line.length > 0, 'Empty RPC record'); accept(JSON.parse(line)); } }); },
    end() { return piEvidence(() => { buffer += decoder.end(); assert.equal(buffer, '', 'Unterminated RPC JSONL record'); }); }
  };
}

export function startRetainedRpc({ invocation, cwd, env, evidence, owners, lifetime }) {
  assert(lifetime?.shutdown, 'Reviewed installed EOF binding is required');
  const receipt = { invocation, cwd, env, lifetime, events: [], errors: [], requests: [], disposition: 'running', descendantSettlement: 'not-established' };
  saveJson(`${evidence}.command.json`, receipt);
  for (const stream of ['stdout', 'stderr', 'stdin']) writeFileSync(`${evidence}.${stream}`, '', { flag: 'wx' });
  const pending = new Map(); const settlementWaiters = new Set(); let sequence = 0, fatal, closing = false, closed = false, exited = false, idle = false;
  let resolveDisposal, rejectDisposal;
  const disposal = new Promise((resolve, reject) => { resolveDisposal = resolve; rejectDisposal = reject; });
  // Attach a rejection observer now, without changing the promise returned to
  // callers. Receipt I/O can fail before the caller reaches its finally block.
  void disposal.catch(() => {});
  const owner = { child: undefined, receipt, disposal }; owners.push(owner);
  const persist = () => { try { saveJson(`${evidence}.result.json`, receipt); } catch (error) { receipt.errors.push(`receipt I/O: ${error}`); fatal ??= uncertainty(error, 'RPC protocol/stream/disposal'); } };
  function fail(error) {
    error = uncertainty(error, 'RPC protocol/stream/disposal');
    fatal ??= uncertainty(error, 'RPC protocol/stream/disposal'); receipt.errors.push(String(error)); idle = false;
    for (const [id, item] of pending) { receipt.requests.find(request => request.id === id).outcome = 'unknown'; item.reject(fatal); }
    if (settlementWaiters.size) receipt.agentWork = 'uncertain';
    pending.clear(); for (const waiter of settlementWaiters) waiter.reject(fatal); settlementWaiters.clear();
    receipt.disposition = 'uncertain; owner retained, no automatic EOF or cancellation'; persist();
  }
  const capture = (stream, bytes) => { try { appendFileSync(`${evidence}.${stream}`, bytes); } catch (error) { fail(error); } };
  const records = [];
  const decoder = jsonlDecoder(message => {
    assert(message && typeof message === 'object' && !Array.isArray(message) && typeof message.type === 'string', 'Invalid RPC record shape');
    records.push(message);
    if (message.type === 'response') {
      const item = pending.get(message.id);
      if (!item) { fail(new Error(`Uncorrelated RPC response: ${JSON.stringify(message)}`)); return; }
      pending.delete(message.id);
      receipt.requests.find(request => request.id === message.id).outcome = message.command === item.type && message.success === true ? 'success' : 'refused-or-mismatched';
      if (message.command !== item.type || message.success !== true) { const error = new Error(`RPC refusal/mismatch: ${JSON.stringify(message)}`); fail(error); item.reject(fatal); return; }
      try {
        if (item.type === 'prompt' && lifetime.version === '1.5.2') {
          assert(['started', 'handled', 'queued'].includes(message.data?.disposition), 'Invalid prompt disposition');
          if (item.expectedDisposition) assert.equal(message.data.disposition, item.expectedDisposition, 'Unexpected prompt disposition');
        }
        if (item.type === 'get_state') {
          assert(typeof message.data?.isStreaming === 'boolean' && typeof message.data?.isCompacting === 'boolean' && Number.isSafeInteger(message.data?.pendingMessageCount) && message.data.pendingMessageCount >= 0, 'Invalid get_state protocol data');
          idle = !message.data.isStreaming && !message.data.isCompacting && message.data.pendingMessageCount === 0;
        }
        if (item.type === 'get_commands') assert(Array.isArray(message.data?.commands) && message.data.commands.every(row => row && typeof row.name === 'string' && ['extension', 'prompt', 'skill'].includes(row.source)), 'Invalid get_commands protocol data');
      } catch (error) { receipt.requests.find(request => request.id === message.id).outcome = 'unknown'; fail(error); item.reject(fatal); return; }
      item.resolve(message);
    } else if (message.type === 'extension_error' || (message.type === 'extension_ui_request' && !['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(message.method))) fail(new Error(`Unexpected RPC extension request/error: ${JSON.stringify(message)}`));
    else if (message.type === 'agent_start') idle = false;
    else if (message.type === 'message_end' && message.message?.role === 'assistant' && ['error', 'aborted'].includes(message.message.stopReason)) fail(new Error(`Provider did not complete: ${JSON.stringify(message)}`));
    else if (message.type === 'agent_settled') { receipt.agentWork = 'settled'; for (const waiter of settlementWaiters) waiter.resolve(); settlementWaiters.clear(); }
  });
  const readableEnded = { stdout: false, stderr: false }; receipt.readableEnded = readableEnded;
  try {
    const child = spawn(invocation.file, invocation.args, { ...invocation.options, shell: false, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); owner.child = child; receipt.pid = child.pid;
    child.stdout.on('data', bytes => { capture('stdout', bytes); try { decoder.push(bytes); } catch (error) { fail(error); } });
    child.stdout.on('end', () => { readableEnded.stdout = true; try { decoder.end(); } catch (error) { fail(error); } });
    child.stderr.on('data', bytes => capture('stderr', bytes));
    child.stderr.on('end', () => { readableEnded.stderr = true; });
    for (const name of ['stdout', 'stderr']) child[name].on('close', () => { if (!readableEnded[name]) fail(new Error(`Premature ${name} close without normal readable end`)); });
    for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('error', error => fail(new Error(`${name}: ${error}`)));
    child.on('error', error => { receipt.events.push({ event: 'error', error: String(error) }); fail(error); });
    child.on('exit', (code, signal) => { exited = true; receipt.events.push({ event: 'exit', code, signal }); });
    child.on('close', (code, signal) => {
      closed = true; receipt.events.push({ event: 'close', code, signal });
      for (const name of ['stdout', 'stderr']) if (!readableEnded[name]) fail(new Error(`Incomplete ${name} capture at child close`));
      if (pending.size || settlementWaiters.size) fail(new Error('RPC closed with pending requests/agent work; outcome unknown'));
      if (!exited || code !== 0 || signal !== null) fail(new Error(`RPC did not exit naturally: ${code}/${signal}`));
      receipt.disposition = fatal ? 'closed with failure/uncertainty; root retained' : 'natural direct-child exit and stream close; root retained';
      persist(); if (fatal) rejectDisposal(fatal); else resolveDisposal(receipt);
    });
  } catch (error) { closed = true; fail(error); rejectDisposal(fatal); }
  const client = {
    owner, records,
    async prompt(message) {
      if (fatal || closing || closed || exited) throw fatal ?? new CandidateUncertainty('RPC no longer accepts prompts');
      receipt.agentWork = 'awaiting-settlement';
      const settled = new Promise((resolve, reject) => settlementWaiters.add({ resolve, reject }));
      await Promise.all([settled, client.request({ type: 'prompt', message }, 'started')]);
    },
    command(message) { return client.request({ type: 'prompt', message }, 'handled'); },
    request(command, expectedDisposition) {
      if (fatal || closing || closed || exited) return Promise.reject(fatal ?? new CandidateUncertainty('RPC no longer accepts requests'));
      const id = `candidate-${++sequence}`; const bytes = `${JSON.stringify({ ...command, id })}\n`;
      receipt.requests.push({ id, type: command.type, outcome: 'awaiting-response' }); if (command.type === 'prompt') idle = false;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, type: command.type, expectedDisposition }); capture('stdin', bytes);
        if (fatal) return;
        try { owner.child.stdin.write(bytes, error => { if (error) fail(error); }); } catch (error) { fail(error); }
      });
    },
    async finish() {
      // A local check failure is not a protocol fault: obtain fresh idle proof
      // before EOF. If that proof fails, return uncertainty with the owner kept.
      if (!closed && !exited) await client.request({ type: 'get_state' });
      if (fatal) throw fatal;
      if (pending.size || settlementWaiters.size || (!closed && !exited && !idle)) {
        fail(new Error('No safe idle EOF proof; owner retained for explicit disposition'));
        throw fatal;
      }
      return client.close();
    },
    close() {
      if (!closing) {
        closing = true;
        if (!closed && !exited && !fatal && pending.size === 0 && settlementWaiters.size === 0 && idle) {
          receipt.disposition = 'EOF requested after correlated idle; waiting for natural close'; persist();
          if (!fatal) try { owner.child.stdin.end(); } catch (error) { fail(error); }
        } else if (!closed && !exited) fail(new Error('No safe idle EOF proof; retaining owner until externally observed natural close'));
      }
      return disposal;
    }
  };
  return client;
}

export async function checkRetainedRpc(rpc, evidence, check) {
  try { return await check(rpc); }
  catch (error) {
    saveJson(`${evidence}.check-error.json`, { name: error?.name, message: error?.message ?? String(error), stack: error?.stack,
      code: error?.code, actual: error?.actual, expected: error?.expected, operator: error?.operator,
      details: inspect(error, { depth: null, customInspect: false, getters: false }) });
    throw error;
  } finally { await rpc.finish(); }
}

export async function runPiCandidate(argv) {
  const owners = [];
  try { return await runPiCandidateOwned(argv, owners); }
  catch (error) {
    if (!(error instanceof CandidateUncertainty) && owners.length === 0) throw error;
    return holdCandidateUncertainty(uncertainty(error, 'Pi candidate ownership/evidence'), owners, argv[argv.indexOf('--root') + 1]);
  }
}
function piEvidence(run) { try { const result = run(); return result?.then ? result.catch(error => { throw uncertainty(error, 'Pi admission/required evidence'); }) : result; } catch (error) { throw uncertainty(error, 'Pi admission/required evidence'); } }
async function runPiCandidateOwned(argv, owners) {
  const { options, common, launch: selection, git, piVersion } = parsePiOptions(argv);
  admitCandidate(options.candidate, options.sha256, options['native-sha256']);
  assert(lstatSync(git).isFile(), 'Git must be an actual admitted program');
  const gitBinding = { path: realpathSync(git), sha256: sha256(readFileSync(git)) };
  const cellPaths = piCellPaths(options.root);
  createFreshRoot(options.root);
  const installRoot = join(options.root, 'installation');
  // Reuse the reviewed fixed installation + neutral dispatch, not a second
  // installer. It owns and retains its own final installation receipts.
  const installArgs = common.map((arg, i) => common[i - 1] === '--root' ? installRoot : common[i - 1] === '--batch' ? 'dispatch' : arg);
  // No option means ordinary dependency resolution, never a hidden minimum pin.
  const install = await runCandidate(installArgs, ...(piVersion ? [{ piVersion }] : []));
  const report = { candidate: install.candidate, install: options.install, installation: join(installRoot, 'results.json'), git: gitBinding, cells: [], ownerDisposition: 'No descendant/transport/PID-absence claim; external admission required for npm, Git, Pi and package builds.' };
  const persist = () => piEvidence(() => saveJson(join(options.root, 'pi-results.json'), report));
  persist();
  if (install.installation.some(row => row.status !== 'passed')) { report.blocked = 'Installation failed; all Pi operations not-run'; persist(); return report; }
  const prefix = join(installRoot, 'prefix'), paths = installationPaths(prefix, options.install);
  const candidate = admitCandidate(options.candidate, options.sha256, options['native-sha256']);
  const tree = jsonFile(join(installRoot, 'installed-inventory.json'));
  const probe = readFileSync(fileURLToPath(new URL('./fixtures/pi-probe-provider.ts', import.meta.url)));
  report.probeSha256 = sha256(probe);
  report.notRun = [
    ['RPC-no-context/non-Git-reload', 'This fixed RPC journey uses plain Git-worktree context only'],
    ['active-profile-instruction-edit-reload', 'Profile selection and Skill edits exercised; active instruction-body edit not implemented'],
    ['Skill-expansion/support-resource-use', 'Descriptions/file provenance and preserved snapshot bytes are checked, not model/tool consumption'],
    ['project-native-resource-trust', 'No project-local extension/Skill trust interaction implemented'],
    ['full-info-collection-detail-format', 'Exact context suppliers, lexical Skills, aliases and corrective actions checked; full flat/reference/digest prose golden not implemented'],
    ['other-Pi-versions', `This run selects ${install.environment.pi.version}; other versions require separate matrix cells`]
  ].map(([cell, reason]) => ({ cell, status: 'not-run', reason }));
  for (const name of ['test-real-pi.mjs', 'test-real-pi-candidate.mjs']) put(join(options.root, 'harness', name), readFileSync(fileURLToPath(new URL(name, import.meta.url))));
  put(join(options.root, 'harness', 'pi-probe-provider.ts'), probe);
  const launches = piEvidence(() => piLaunches(install.environment.pi, paths, selection));
  report.pi = { ...install.environment.pi, launches, selection: install.environment.piSelection, lifetime: piEvidence(() => bindRpcLifetime(install.environment.pi)), untestedVersions: `Every version other than selected ${install.environment.pi.version}` };
  let cellIndex = 0;
  for (const alias of options.alias === 'both' ? ['bazframe', 'bzf'] : [options.alias]) for (const launch of launches) {
    const physicalCell = cellPaths[cellIndex++];
    const cell = { alias, launch: launch.kind, physicalCell, operations: [] }; report.cells.push(cell); persist();
    if (launch.status === 'not-run') { cell.operations.push({ operation: 'default-Pi-journey', status: 'not-run', reason: launch.reason }); persist(); continue; }
    const root = physicalCell.root; mkdirSync(root);
    const env = isolatedEnvironment(root, prefix);
    env.PATH = [dirname(process.execPath), dirname(gitBinding.path), ...(process.platform === 'win32' ? [join(env.SystemRoot, 'System32'), env.SystemRoot] : ['/usr/bin', '/bin'])].filter((path, i, paths) => paths.indexOf(path) === i).join(delimiter);
    Object.assign(env, { BAZFRAME_PI_PROBE_CAPTURE: join(root, 'captures.jsonl'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', BAZFRAME_GIT_COMMAND: gitBinding.path });
    cell.git = piEvidence(() => bindSelectedGit(gitBinding.path, env));
    const executable = join(paths.bin, alias + (process.platform === 'win32' ? '.cmd' : ''));
    const launcherHash = sha256(readFileSync(executable));
    const revalidate = () => piEvidence(() => {
      admitCandidate(options.candidate, options.sha256, options['native-sha256']); verifyInstalled(paths.packageRoot, candidate);
      assert.deepEqual(inventory(paths.modules), tree, 'Installed tree changed');
      assert.equal(sha256(readFileSync(process.execPath)), install.environment.nodeSha256);
      assert.equal(sha256(readFileSync(executable)), launcherHash);
      assert.equal(sha256(readFileSync(gitBinding.path)), gitBinding.sha256);
      assert.deepEqual(bindSelectedGit(gitBinding.path, env), cell.git);
      if (install.environment.cmd) assert.equal(sha256(readFileSync(env.ComSpec)), install.environment.cmd.sha256);
    });
    const c = { root, home: env.BAZFRAME_HOME, env, executable, launch, owners, probe, pi: install.environment.pi, packageRoot: paths.packageRoot, git: gitBinding.path, revalidate, run: retainedRunner(join(root, 'commands'), owners), cwd: join(root, 'non-git'), repository: join(root, 'repository') };
    await runSteps(piJourneySteps(c), cell.operations, persist);
  }
  report.ownerCount = owners.length; persist();
  if (report.cells.some(c => c.operations.some(row => row.status === 'failed'))) process.exitCode = 1;
  return report;
}

const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function assertPrompt(capture, { enabled = true, replacement = false, profile = 'ALPHA_BODY', repository = true, resources = ['DIRECT_MARKER', 'LIBRARY_MARKER', 'PACKAGE_MARKER'], profilePath, globalPath, repositoryPath } = {}) {
  assert(globalPath && (!repository || repositoryPath) && (!enabled || profilePath), 'Exact context paths required');
  const prompt = capture.systemPrompt;
  const count = marker => prompt.split(marker).length - 1;
  assert.equal(count('GLOBAL_BODY'), 1, 'Native/restored global context exactly once');
  assert.equal(count('REPOSITORY_BODY'), repository && !replacement ? 1 : 0);
  assert.equal(count(profile), enabled ? 1 : 0);
  for (const marker of resources) assert.equal(count(marker), enabled ? 1 : 0, `Skill projection ${marker}`);
  const global = replacement ? `<bazframe_global_instructions path="${escapeAttribute(globalPath)}">\nGLOBAL_BODY\n\n</bazframe_global_instructions>` : `<project_instructions path="${globalPath}">\nGLOBAL_BODY\n\n</project_instructions>`;
  assert(prompt.includes(global), 'Exact global path/body transport');
  assert.deepEqual([...prompt.matchAll(/<project_instructions path="([^"]+)">/gu)].map(match => match[1]), replacement ? [] : [globalPath, ...(repository ? [repositoryPath] : [])], 'Exact native context supplier set/order');
  const repo = `<project_instructions path="${repositoryPath}">\nREPOSITORY_BODY\n\n</project_instructions>`;
  if (repository && !replacement) { assert(prompt.includes(repo), 'Exact repository path/body transport'); assert(prompt.indexOf(global) < prompt.indexOf(repo), 'Global before repository context'); }
  assert.equal(count('<bazframe_profile_instructions '), enabled ? 1 : 0);
  assert.equal(count('<bazframe_global_instructions '), replacement ? 1 : 0);
  if (enabled) {
    const section = `<bazframe_profile_instructions path="${escapeAttribute(profilePath)}">\n${profile}\n\n</bazframe_profile_instructions>`;
    assert(prompt.endsWith(section), 'Exact profile path/body must end composed prompt');
    assert(prompt.indexOf(global) < prompt.indexOf(section));
    if (repository && !replacement) assert(prompt.indexOf(repo) < prompt.indexOf(section));
    if (replacement) assert(prompt.endsWith(`${global}\n\n${section}`), 'Restored global/profile exact order and separator');
  }
}

export function assertCollectionConflictInfo(message) {
  const lines = message.split('\n');
  for (const line of ['Profile library/package references: 2', 'Derived effective skills: 0', 'Library/package failures: 2',
    '  - library demo-library:library-skill/SKILL.md duplicate-name (library-skill)',
    '  - package demo-package:package-skill/SKILL.md duplicate-name (package-skill)']) assert(lines.includes(line), `Missing collision diagnostic: ${line}`);
  const correction = lines.indexOf('Corrective actions:'), skills = lines.findIndex(line => line.startsWith('Skills:'));
  assert(correction >= 0 && skills > correction, 'Missing or misordered corrective-action section');
  assert.deepEqual(lines.slice(correction + 1, skills), ['  - Inspect failures with `bazframe profile library list` and `bazframe profile package list`.']);
}

export function assertInfo(message, { profileId, profilePath, globalPath, repositoryPath, skills, aliases = [] }) {
  const lines = message.split('\n'), flat = lines.indexOf(lines.find(line => line.startsWith('Flat direct skills:')));
  assert.deepEqual(lines.slice(0, flat), [`Profile: ${profileId ?? '(none)'}`, 'Context:', `  (pi) ${globalPath}`, `  (pi) ${repositoryPath}`, ...(profileId ? [`  (bazframe) ${profilePath}`] : [])], 'Exact ordered info context suppliers');
  assert.deepEqual(lines.filter(line => line.startsWith('Skills:')), [`Skills: ${skills.length ? [...new Set(skills)].sort().join(', ') : '(none)'}`], 'Exact lexical effective Skill report');
  assert.deepEqual(lines.filter(line => line.startsWith('Aliases:')), aliases.length ? [`Aliases: ${[...aliases].sort().join(', ')}`] : [], 'Exact live alias report');
}

export function assertSkillLocations(prompt, expected) {
  const actual = [...prompt.matchAll(/<skill>\s*<name>([^<]+)<\/name>\s*<description>([^<]+)<\/description>\s*<location>([^<]+)<\/location>\s*<\/skill>/gu)].map(match => ({ name: match[1], description: match[2], location: match[3] }));
  const encode = value => escapeAttribute(value).replaceAll("'", '&apos;');
  assert.deepEqual(actual.sort((a, b) => a.name.localeCompare(b.name)), expected.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encode(value)]))).sort((a, b) => a.name.localeCompare(b.name)), 'Exact Skill file provenance/description set');
}

// Preserve the raw composed bytes, including their final newline. The CLI adds
// one framing newline on each side; do not trim or normalize the body.
export function deprecatedDryRunBody(stdout) {
  const start = Buffer.from('--- effective instructions ---\n'), end = Buffer.from('\n--- end effective instructions ---\n');
  const first = stdout.indexOf(start), last = stdout.indexOf(end, first + start.length);
  assert(first >= 0 && last > first + start.length, 'Missing dry-run effective instruction body');
  assert.equal(stdout.indexOf(start, first + start.length), -1, 'Ambiguous dry-run instruction body');
  assert.equal(stdout.indexOf(end, last + end.length), -1, 'Ambiguous dry-run instruction body');
  return Buffer.from(stdout.subarray(first + start.length, last));
}

export function assertDeprecatedTemporaryDisposition(stderr, { temporaryRoot, repository, expectedBody }, platform = process.platform) {
  const paths = [...stderr.toString().matchAll(/^Effective instructions file: (.+)\r?$/gmu)];
  assert.equal(paths.length, 1, 'Missing or ambiguous product temporary instruction path');
  const path = paths[0][1].trim();
  const scope = 'Product-owned temporary-file disposition only; harness roots retained; no descendant settlement inferred.';
  if (platform !== 'win32') {
    assert(!existsSync(path), 'Deprecated launcher should remove its own temporary instruction file');
    return { path, disposition: 'removed', fileAbsent: true, scope };
  }
  // run-cli's NO_COLOR prose failure prefix is lowercase; reviewed Pi 0.84.4
  // and 1.5.2 invalid-enum diagnostics use uppercase "Error: ". Exit 1 alone
  // cannot distinguish the expected parser failure from failed disposal proof.
  assert(!/^error: /mu.test(stderr.toString()), 'Bazframe reported a launcher/disposal error');
  assert(Buffer.isBuffer(expectedBody), 'Prior dry-run effective instruction bytes required');
  const root = realpathSync(temporaryRoot), repo = realpathSync(repository), directory = dirname(path);
  const within = (parent, child) => { const rel = relative(parent, child); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  assert(isAbsolute(path) && dirname(directory) === root && basename(path) === '.baz.agents.md' && /^bazframe-profile-dry-run-[a-f0-9]{32}$/u.test(basename(directory)), 'Unexpected product temporary instruction path');
  assert(!within(repo, root), 'Temporary instructions must be outside repository');
  const observe = () => [root, directory, path].map((entry, index) => {
    const stat = lstatSync(entry, { bigint: true });
    assert(!stat.isSymbolicLink() && (index === 2 ? stat.isFile() && stat.nlink === 1n : stat.isDirectory()), 'Temporary instructions require physical directories and a single-link regular file');
    assert.equal(realpathSync(entry), entry, 'Temporary instruction path alias');
    return { path: entry, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), nlink: String(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
  });
  const before = observe(), bytes = readFileSync(path), after = observe();
  assert.deepEqual(after, before, 'Temporary instruction identity/metadata changed during read');
  assert.deepEqual(bytes, expectedBody, 'Retained temporary instruction bytes differ from dry-run');
  // These are post-exit observations, not native creation/ACL receipts. Privacy
  // and ownership remain established by the admitted product's private creation,
  // publication and guarded disposal proofs (including on natural child exit 1).
  return { path, disposition: 'retained', fileAbsent: false, bytes: bytes.length, sha256: sha256(bytes), observedIdentity: after,
    ownershipBasis: 'Admitted Windows product private creation/publication and guarded disposal; lstat is not independent ACL or creation proof.', scope };
}

// A single fixed suffix, not a general checkpoint/resume API. The caller must
// authenticate these original receipts; fresh observations never replace them.
export function piJourneySteps(c, resume) {
  const steps = [], agent = c.env.PI_CODING_AGENT_DIR;
  let repositoryBaseline, gitStatusBaseline, deprecatedBody, preservationSequence = 0;
  let resumeAdmitted = false;
  if (resume !== undefined) {
    assert(resume && resume.repositoryBaseline?.inventory && typeof resume.repositoryBaseline.gitStatusBase64 === 'string', 'Original repository/Git baseline required');
    for (const key of ['adapterBinding', 'importBinding', 'homeInventory', 'sourceInventory', 'agentInventory']) assert(resume[key] && typeof resume[key] === 'object', `Original ${key} required`);
    assert(Buffer.isBuffer(resume.dryRunStdout), 'Original dry-run stdout required');
    deprecatedBody = deprecatedDryRunBody(resume.dryRunStdout);
    resume = structuredClone(resume);
    repositoryBaseline = resume.repositoryBaseline.inventory;
    gitStatusBaseline = Buffer.from(resume.repositoryBaseline.gitStatusBase64, 'base64');
  }
  const temporaryDisposition = result => assertDeprecatedTemporaryDisposition(result.stderr, { temporaryRoot: c.env.TMPDIR, repository: c.repository, expectedBody: deprecatedBody });
  const gitStatus = async () => {
    c.revalidate();
    const result = await c.run(`git-status-${++preservationSequence}`, { file: c.git, args: ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'] }, c.repository, c.env);
    assertNaturalResult(result); return result.stdout;
  };
  const add = (name, run) => steps.push({ name, run: async () => {
    if (resume && !resumeAdmitted) {
      c.revalidate();
      assert.deepEqual(inventory(c.home), resume.homeInventory, 'Original home/imported state changed');
      assert.deepEqual(inventory(join(c.root, 'sources')), resume.sourceInventory, 'Original source state changed');
      assert.deepEqual(inventory(agent), resume.agentInventory, 'Original agent state changed');
      assert.deepEqual(jsonFile(join(c.root, 'import-binding.json')), resume.importBinding, 'Original import document changed');
      const binding = resume.importBinding;
      assert.equal(binding.zip, join(c.root, 'alpha.zip'), 'Original import archive path required');
      assert.equal(sha256(readFileSync(binding.zip)), binding.sha256, 'Original import archive changed');
      assert.equal(binding.document?.outcome, 'success');
      assert.equal(binding.document?.result?.resolvedName, 'alpha-1');
      assert(c.imported === undefined || c.imported === 'alpha-1', 'Imported identity changed');
      assert.equal(readFileSync(join(c.home, 'active-profile'), 'utf8').trim(), 'alpha-1', 'Imported selection changed');
      assert.deepEqual(readFileSync(join(agent, 'extensions', '99-probe-provider.ts')), c.probe, 'Frozen provider changed');
      admitAdapter();
      for (const path of [globalState, projectState(), join(c.root, 'retained-malformed-global.json'), join(c.root, 'retained-malformed-project.json')]) {
        // existsSync would miss an occupied dangling link.
        assert.equal(inventory(path), null, `Suffix destination occupied: ${path}`);
      }
      c.imported = 'alpha-1';
      // Mark admitted only after the original repository and fresh Git status
      // compare below, so a failed preflight cannot be bypassed on another call.
    }
    if (repositoryBaseline) { assert.deepEqual(inventory(c.repository), repositoryBaseline, 'Repository/Git bytes changed before operation'); assert.deepEqual(await gitStatus(), gitStatusBaseline, 'Git status changed before operation'); }
    if (resume) resumeAdmitted = true;
    const detail = await run();
    if (repositoryBaseline) { assert.deepEqual(inventory(c.repository), repositoryBaseline, 'Repository/Git bytes changed'); assert.deepEqual(await gitStatus(), gitStatusBaseline, 'Git status changed'); }
    return detail;
  } });
  let commandNumber = 0, adapterBinding = resume?.adapterBinding;
  const admitAdapter = () => piEvidence(() => { const current = verifyAdapter(c); if (adapterBinding) assert.deepEqual(current, adapterBinding, 'Installed adapter bytes changed since installation'); return current; });
  async function cli(args, { code = 0, env = c.env, cwd = c.cwd, text, unchanged = false } = {}) {
    c.revalidate(); const before = inventory(env.BAZFRAME_HOME), sourcesBefore = inventory(join(c.root, 'sources'));
    const result = await c.run(`cli-${++commandNumber}`, aliasInvocation(c.executable, args, process.platform, env.ComSpec), cwd, env);
    const sourcesAfter = inventory(join(c.root, 'sources'));
    saveJson(`${result.evidence}.disk.json`, { before, after: inventory(env.BAZFRAME_HOME), sourcesBefore, sourcesAfter });
    if (/PACKAGE_BUILD_TERMINATION_UNCERTAIN|Package build timed out|Package build terminated by signal|descendant processes remained/u.test(`${result.stdout}${result.stderr}`)) throw new CandidateUncertainty('Product reported child-work uncertainty; raw command retained');
    assertNaturalResult(result, code);
    if (text) assert(`${result.stdout}${result.stderr}`.includes(text), `Missing diagnostic: ${text}`);
    if (unchanged) assert.deepEqual(inventory(env.BAZFRAME_HOME), before, 'Read/refusal changed state');
    if (!(args[0] === 'package' && ['add', 'build'].includes(args[1]))) assert.deepEqual(sourcesAfter, sourcesBefore, 'CLI mutated source-owned resources');
    return result;
  }
  function captures(required = false) {
    if (!existsSync(c.env.BAZFRAME_PI_PROBE_CAPTURE)) { if (required) throw new CandidateUncertainty('Required provider capture is absent'); return []; }
    const rows = []; const decoder = jsonlDecoder(row => rows.push(row)); decoder.push(readFileSync(c.env.BAZFRAME_PI_PROBE_CAPTURE)); decoder.end(); return rows;
  }
  async function print(label, expectation, extra = [], cwd = c.repository) {
    c.revalidate(); const before = captures().length;
    const sources = inventory(join(c.root, 'sources'));
    const resourcePaths = ['skill-snapshots', 'profiles', 'libraries', 'packages', 'profile-publishing/blobs', 'profile-publishing/trees'];
    const stores = resourcePaths.map(path => inventory(join(c.home, path)));
    if (adapterBinding || existsSync(extension)) admitAdapter();
    assert.deepEqual(readFileSync(join(agent, 'extensions', '99-probe-provider.ts')), c.probe);
    const result = await c.run(label, piInvocation(c.launch, [...probeArgs, '--print', ...extra, 'capture task context'], c.env), cwd, c.env);
    assertNaturalResult(result); assert(result.stdout.toString().includes('probe-ok'));
    const rows = captures(true); assert.equal(rows.length, before + 1, 'Exactly one actual provider capture');
    assert.equal(rows.at(-1).cwd, realpathSync(cwd)); assertPrompt(rows.at(-1), { ...contextPaths(readFileSync(join(c.home, 'active-profile'), 'utf8').trim()), ...expectation });
    assert.deepEqual(inventory(join(c.root, 'sources')), sources, 'Pi mutated source-owned resources');
    assert.deepEqual(resourcePaths.map(path => inventory(join(c.home, path))), stores, 'Pi mutated snapshots/profile/reference bytes');
    if (['ordinary-plain', 'ordinary-no-context', 'imported-plain', 'imported-no-context'].includes(label)) {
      const imported = label.startsWith('imported-') ? jsonFile(join(profile(c.imported), '.bazframe-profile-state.json')).importedResources : undefined;
      const resourceRoot = (kind, id) => {
        if (imported) {
          const item = imported.find(item => item.key.kind === kind && item.key.name === id);
          assert(item?.source.kind === 'artifact' && /^[a-f0-9]{64}$/u.test(item.source.treeId), 'Expected captured imported resource identity');
          return join(c.home, 'profile-publishing', 'trees', item.source.treeId, 'root');
        }
        if (kind === 'skill') {
          // POSIX standalone adapter passes the membership SKILL.md spelling;
          // native services pass the admitted target. Pi preserves that spelling.
          const membership = join(profile('alpha'), 'skills', 'direct-skill');
          assert.equal(realpathSync(membership), realpathSync(direct), 'Added Skill membership must resolve to the physical source');
          return process.platform === 'win32' ? realpathSync(direct) : membership;
        }
        const record = jsonFile(join(c.home, kind === 'library' ? 'libraries' : 'packages', `${id}.json`));
        return join(c.home, 'skill-snapshots', 'sha256', record.digest, 'artifact');
      };
      const directRoot = resourceRoot('skill', 'direct-skill'), libraryRoot = resourceRoot('library', 'demo-library'), packageRoot = resourceRoot('package', 'demo-package');
      assertSkillLocations(rows.at(-1).systemPrompt, [
        { name: 'direct-skill', description: 'DIRECT_MARKER', location: join(directRoot, 'SKILL.md') },
        ...[['library-skill', 'LIBRARY_MARKER'], ['library-companion', 'LIBRARY_COMPANION']].map(([name, description]) => ({ name, description, location: join(libraryRoot, name, 'SKILL.md') })),
        ...[['package-skill', 'PACKAGE_MARKER'], ['package-companion', 'PACKAGE_COMPANION']].map(([name, description]) => ({ name, description, location: join(packageRoot, 'skills', name, 'SKILL.md') }))
      ]);
    }
    return { evidence: result.evidence, capture: before };
  }
  async function inspectRpc(label, check) {
    c.revalidate(); admitAdapter(); const lifetime = piEvidence(() => bindRpcLifetime(c.pi));
    const rpc = startRetainedRpc({ invocation: piInvocation(c.launch, ['--mode', 'rpc', ...probeArgs], c.env), cwd: c.repository, env: c.env, evidence: join(c.root, label), owners: c.owners, lifetime });
    await checkRetainedRpc(rpc, join(c.root, label), async () => { await rpc.request({ type: 'get_state' }); await check(rpc); });
  }
  const source = join(c.root, 'sources'), direct = join(source, 'direct-skill'), library = join(source, 'demo-library'), pkg = join(source, 'demo-package');
  const profile = name => join(c.home, 'profiles', name);
  const contextPaths = name => ({ profilePath: join(profile(name), 'AGENTS.md'), globalPath: join(agent, 'AGENTS.md'), repositoryPath: join(c.repository, 'AGENTS.md') });
  async function info(rpc, profileId, skills, aliases = [], error = false) {
    const before = rpc.records.length; await rpc.command('/bazframe info');
    const notifications = rpc.records.slice(before).filter(row => row.type === 'extension_ui_request' && row.method === 'notify');
    assert.equal(notifications.length, 1, 'One actual info notification');
    assert.equal(notifications[0].notifyType, error ? 'error' : 'info');
    assertInfo(notifications[0].message, { ...contextPaths(profileId ?? 'alpha'), profileId, skills, aliases });
    return notifications[0].message;
  }
  const extension = join(agent, 'extensions', 'bazframe.ts');
  const globalState = join(c.home, 'global.json');
  const projectState = () => join(c.home, 'projects', `${sha256(realpathSync(c.repository))}.json`);
  add('installed-Pi-version', async () => { c.revalidate(); const result = await c.run('pi-version', piInvocation(c.launch, ['--version'], c.env), c.root, c.env); assertNaturalResult(result); assert.equal(result.stdout.toString().trim(), c.pi.version); return { evidence: result.evidence, invocation: c.launch.kind }; });
  add('prepare-offline-fixtures', async () => {
    mkdirSync(c.cwd); mkdirSync(c.repository);
    put(join(agent, 'AGENTS.md'), 'GLOBAL_BODY\n'); put(join(c.repository, 'AGENTS.md'), 'REPOSITORY_BODY\n');
    put(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enableInstallTelemetry: false }));
    put(join(agent, 'extensions', '99-probe-provider.ts'), c.probe);
    put(join(agent, 'extensions', 'unrelated.txt'), 'unrelated adapter bystander');
    for (const [path, name, marker] of [[direct, 'direct-skill', 'DIRECT_MARKER'], [join(library, 'library-skill'), 'library-skill', 'LIBRARY_MARKER'], [join(library, 'library-companion'), 'library-companion', 'LIBRARY_COMPANION']]) put(join(path, 'SKILL.md'), skill(name, marker));
    put(join(pkg, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    // Revision-specific outputs avoid deleting even source-owned old artifacts.
    put(join(pkg, 'build.mjs'), `import{mkdirSync,writeFileSync,readFileSync}from'node:fs';const names=JSON.parse(readFileSync('skills.json'));for(const [name,marker]of names){mkdirSync('dist/skills/'+name,{recursive:true});writeFileSync('dist/skills/'+name+'/SKILL.md','---\\nname: '+name+'\\ndescription: '+marker+'\\n---\\n# '+name+'\\n')}mkdirSync('dist/shared',{recursive:true});writeFileSync('dist/shared/resource.txt','SHARED_RESOURCE');`);
    put(join(pkg, 'skills.json'), JSON.stringify([['package-skill', 'PACKAGE_MARKER'], ['package-companion', 'PACKAGE_COMPANION']]));
    c.revalidate(); assertNaturalResult(await c.run('git-init', { file: c.git, args: ['init', '--quiet'] }, c.repository, c.env));
    gitStatusBaseline = await gitStatus(); repositoryBaseline = inventory(c.repository);
    saveJson(join(c.root, 'repository-baseline.json'), { inventory: repositoryBaseline, gitStatusBase64: gitStatusBaseline.toString('base64') });
  });
  for (const name of ['alpha', 'beta']) {
    add(`create-${name}`, async () => { await cli(['profile', 'add', name]); put(join(profile(name), 'AGENTS.md'), `${name.toUpperCase()}_BODY\n`); });
  }
  add('ordinary-resource-membership', async () => {
    await cli(['profile', 'use', 'alpha']);
    for (const [kind, path, id] of [['skill', direct, 'direct-skill'], ['library', library, 'demo-library'], ['package', pkg, 'demo-package']]) {
      await cli([kind, 'add', path]); await cli(['profile', kind, 'add', id]);
    }
    assert.equal(realpathSync(join(profile('alpha'), 'skills', 'direct-skill')), realpathSync(direct));
  });
  add('adapter-install-current-unrelated-preserved', async () => {
    await cli(['adapter', 'list'], { text: 'pi' }); await cli(['adapter', 'install', 'pi']);
    adapterBinding = admitAdapter();
    saveJson(join(c.root, 'installed-adapter-binding.json'), adapterBinding);
    await cli(['adapter', 'install', 'pi'], { text: 'current' }); await cli(['status'], { text: 'Pi adapter: current' });
    assert.equal(readFileSync(join(agent, 'extensions', 'unrelated.txt'), 'utf8'), 'unrelated adapter bystander');
  });
  add('git-file-free-default', async () => { await cli(['status'], { cwd: c.repository, text: 'inherits global policy' }); assert(!existsSync(globalState)); assert(!existsSync(projectState())); });
  add('ordinary-plain', () => print('ordinary-plain', {}));
  add('ordinary-no-context', () => print('ordinary-no-context', { replacement: true }, ['-nc']));
  add('non-git-default', () => print('non-git-default', { repository: false }, [], c.cwd));
  add('global-disable-both-directories', async () => {
    await cli(['global', 'disable']); assert.equal(jsonFile(globalState).disabled, true);
    await print('disabled-git', { enabled: false }); await print('disabled-non-git', { enabled: false, repository: false }, [], c.cwd);
  });
  add('project-enable-overrides-disabled-global', async () => {
    await cli(['project', 'enable'], { cwd: c.repository }); assert(existsSync(projectState())); await print('enabled-override', { replacement: true }, ['-nc']);
    await cli(['project', 'disable'], { cwd: c.repository }); assert(!existsSync(projectState()), 'Matching disabled behavior returns to inheritance');
  });
  add('project-disable-overrides-enabled-global', async () => {
    await cli(['global', 'enable']); assert(!existsSync(globalState)); await cli(['project', 'disable'], { cwd: c.repository });
    await print('disabled-override', { enabled: false }); await cli(['project', 'list'], { cwd: c.repository, text: 'disabled' }); await cli(['global', 'show'], { text: 'enabled' });
    await cli(['project', 'enable'], { cwd: c.repository }); assert(!existsSync(projectState()));
  });
  const archive = join(c.root, 'alpha.zip');
  add('export-import-real-resources', async () => {
    await cli(['profile', 'export', '--profile', 'alpha', '--output', archive, '--json']);
    const result = await cli(['profile', 'import', archive, '--yes', '--json']); const document = JSON.parse(result.stdout.toString());
    assert.equal(document.outcome, 'success'); assert.equal(document.result.resolvedName, 'alpha-1'); assert(existsSync(profile('alpha-1'))); c.imported = 'alpha-1';
    saveJson(join(c.root, 'import-binding.json'), { zip: archive, sha256: sha256(readFileSync(archive)), document });
    await cli(['profile', 'use', c.imported]);
  });
  add('imported-plain', () => print('imported-plain', {}));
  add('imported-no-context', () => print('imported-no-context', { replacement: true }, ['-nc']));
  add('same-process-reload-profile-policy-and-resources', async () => {
    await cli(['profile', 'use', 'alpha']); c.revalidate();
    admitAdapter(); const lifetime = piEvidence(() => bindRpcLifetime(c.pi)); saveJson(join(c.root, 'rpc-lifetime-binding.json'), lifetime);
    const rpc = startRetainedRpc({ invocation: piInvocation(c.launch, ['--mode', 'rpc', ...probeArgs], c.env), cwd: c.repository, env: c.env, evidence: join(c.root, 'rpc'), owners: c.owners, lifetime });
    const commands = async () => (await rpc.request({ type: 'get_commands' })).data.commands;
    const names = rows => rows.map(row => row.name);
    const reload = async () => { await rpc.command('/bazframe reload'); };
    let modelPrompts = 0;
    const capture = async (expectation, profileId = 'alpha') => { const before = captures().length; await rpc.prompt('same-process offline context'); modelPrompts++; assert.equal(captures(true).length, before + 1); assertPrompt(captures().at(-1), { ...contextPaths(profileId), ...expectation }); };
    await checkRetainedRpc(rpc, join(c.root, 'rpc'), async () => {
      await rpc.request({ type: 'get_state' });
      const initial = await commands(); assert(names(initial).includes('bazframe')); assert(names(initial).includes('skill:direct-skill'));
      await info(rpc, 'alpha', ['direct-skill', 'library-skill', 'library-companion', 'package-skill', 'package-companion']);
      put(join(direct, 'SKILL.md'), skill('direct-skill', 'DIRECT_LIVE'));
      put(join(library, 'library-live', 'SKILL.md'), skill('library-live', 'LIBRARY_LIVE'));
      put(join(pkg, 'skills.json'), JSON.stringify([['package-skill', 'PACKAGE_MARKER'], ['package-companion', 'PACKAGE_COMPANION'], ['package-live', 'PACKAGE_LIVE']]));
      assert.deepEqual(await commands(), initial, 'Mutable source changes visible before explicit update/reload');
      await cli(['library', 'update', 'demo-library']); await cli(['package', 'build', 'demo-package']);
      assert.deepEqual(await commands(), initial, 'Activated snapshot changed existing Pi without reload');
      await reload(); const updated = await commands();
      for (const name of ['library-live', 'package-live']) assert(names(updated).includes(`skill:${name}`)); assert(JSON.stringify(updated).includes('DIRECT_LIVE'));
      await cli(['global', 'disable']); assert.deepEqual(await commands(), updated); await reload();
      assert(!names(await commands()).includes('skill:direct-skill'));
      await cli(['global', 'enable']); await reload(); assert(names(await commands()).includes('skill:direct-skill'));
      await cli(['profile', 'use', 'beta']); assert(names(await commands()).includes('skill:direct-skill'));
      await capture({ resources: ['DIRECT_LIVE', 'LIBRARY_MARKER', 'PACKAGE_MARKER'] });
      await reload(); assert(!names(await commands()).includes('skill:direct-skill'));
      await capture({ profile: 'BETA_BODY', resources: [] }, 'beta'); assert(!captures().at(-1).systemPrompt.includes('ALPHA_BODY'));
      await info(rpc, 'beta', []);
      await cli(['profile', 'use', c.imported]); assert(!names(await commands()).includes('skill:direct-skill')); await reload();
      assert(names(await commands()).includes('skill:direct-skill'), 'Imported profile switch must converge in same process');
      await capture({}, c.imported); assert(!captures().at(-1).systemPrompt.includes('BETA_BODY'));
      assert.equal(rpc.records.filter(row => row.type === 'agent_start').length, modelPrompts, 'Commands/reload must not call provider');
      const state = (await rpc.request({ type: 'get_state' })).data; assert.equal(state.isStreaming, false); assert.equal(state.pendingMessageCount, 0);
    });
  });
  add('native-name-collision-alias', async () => {
    await cli(['profile', 'use', 'alpha']); put(join(agent, 'skills', 'direct-skill', 'SKILL.md'), skill('direct-skill', 'NATIVE_OCCUPANT'));
    await print('native-name-collision', { resources: ['DIRECT_LIVE', 'LIBRARY_MARKER', 'PACKAGE_MARKER'] });
    assert(captures().at(-1).systemPrompt.includes('<name>direct-skill-x-bazframe</name>'), 'Deterministic alias missing');
    await inspectRpc('native-alias-info', rpc => info(rpc, 'alpha', ['direct-skill', 'direct-skill-x-bazframe', 'library-skill', 'library-companion', 'library-live', 'package-skill', 'package-companion', 'package-live'], ['direct-skill -> direct-skill-x-bazframe']));
  });
  add('occupied-alias-withholds-profile-projection', async () => {
    put(join(agent, 'skills', 'direct-skill-x-bazframe', 'SKILL.md'), skill('direct-skill-x-bazframe', 'ALIAS_OCCUPANT'));
    const before = captures().length; c.revalidate();
    const result = await c.run('occupied-alias-input-refusal', piInvocation(c.launch, [...probeArgs, '--print', 'must be handled without provider'], c.env), c.repository, c.env);
    assertNaturalResult(result, 1); assert.equal(captures().length, before, 'Failed projection must not call provider');
    assert(result.stderr.toString().includes('Bazframe Pi adapter failed explicitly'));
    await inspectRpc('occupied-alias-info', async rpc => {
      const commands = (await rpc.request({ type: 'get_commands' })).data.commands.map(row => row.name);
      for (const name of ['skill:library-skill', 'skill:package-skill']) assert(!commands.includes(name));
      assert(commands.includes('skill:direct-skill') && commands.includes('skill:direct-skill-x-bazframe'));
      await info(rpc, undefined, ['direct-skill', 'direct-skill-x-bazframe'], [], true);
    });
    // Retain fixture occupants outside discovery rather than delete them.
    renameSync(join(agent, 'skills'), join(c.root, 'retained-native-collision-skills'));
  });
  add('whole-collection-withholding-preserves-references', async () => {
    const references = [join(profile('alpha'), 'libraries'), join(profile('alpha'), 'packages')].map(path => inventory(path));
    for (const [name, marker] of [['library-skill', 'PHYSICAL_LIBRARY_WINNER'], ['package-skill', 'PHYSICAL_PACKAGE_WINNER']]) put(join(profile('alpha'), 'skills', name, 'SKILL.md'), skill(name, marker));
    await print('whole-object-conflict', { resources: ['DIRECT_LIVE', 'PHYSICAL_LIBRARY_WINNER', 'PHYSICAL_PACKAGE_WINNER'] });
    const prompt = captures().at(-1).systemPrompt;
    for (const marker of ['LIBRARY_MARKER', 'LIBRARY_COMPANION', 'PACKAGE_MARKER', 'PACKAGE_COMPANION', 'LIBRARY_LIVE', 'PACKAGE_LIVE']) assert(!prompt.includes(marker), `Whole conflicting contribution leaked: ${marker}`);
    assert.deepEqual([join(profile('alpha'), 'libraries'), join(profile('alpha'), 'packages')].map(path => inventory(path)), references);
    await inspectRpc('collection-corrective-info', async rpc => { assertCollectionConflictInfo(await info(rpc, 'alpha', ['direct-skill', 'library-skill', 'package-skill'])); });
  });
  add('deprecated-dry-run-and-forwarding-refusals', async () => {
    await cli(['profile', 'use', c.imported]);
    const dryRun = await cli(['pi', '--dry-run'], { cwd: c.repository, text: 'Would launch executable: pi' });
    deprecatedBody = deprecatedDryRunBody(dryRun.stdout);
    await cli(['pi', '--', '--session', 'forbidden'], { cwd: c.repository, code: 2, text: 'not supported', unchanged: true });
    await cli(['pi', '--json'], { cwd: c.repository, code: 2, text: 'CLI_JSON_UNSUPPORTED', unchanged: true });
  });
  add('deprecated-real-launch-and-natural-exit', async () => {
    if (c.launch.kind !== 'genuine-pi-shim') return { status: 'not-run', reason: 'Deprecated CLI resolves pi on PATH; direct Node choice is not an alias. Use separately admitted genuine shim cell.' };
    const env = { ...c.env, PATH: `${dirname(c.launch.file)}${delimiter}${c.env.PATH}` };
    const before = captures().length;
    const result = await cli(['pi', '--', ...probeArgs, '--print', 'deprecated offline capture'], { env, cwd: c.repository, text: 'probe-ok' });
    assert.equal(captures().length, before + 1); assert(captures().at(-1).systemPrompt.includes('ALPHA_BODY'));
    return { evidence: result.evidence, cleanup: temporaryDisposition(result) };
  });
  add('deprecated-natural-nonzero-propagation', async () => {
    if (c.launch.kind !== 'genuine-pi-shim') return { status: 'not-run', reason: 'Requires an admitted deprecated-launch-capable actual Pi shim; no substitute child supplied.' };
    const env = { ...c.env, PATH: `${dirname(c.launch.file)}${delimiter}${c.env.PATH}` }, before = captures().length;
    // Reviewed Pi parser emits an error diagnostic before startup for this
    // invalid enum. This exercises natural child exit 1, not terminal behavior.
    const result = await cli(['pi', '--', ...probeArgs, '--print', '--tui-mode', 'candidate-invalid'], { env, cwd: c.repository, code: 1, text: 'Invalid TUI mode' });
    assert.equal(captures().length, before, 'Parser failure must not invoke provider');
    return { evidence: result.evidence, childOutcome: 'Actual installed Pi parser diagnostic and propagated exit 1.', cleanup: temporaryDisposition(result) };
  });
  add('deprecated-signal-propagation', () => ({ status: 'not-run', reason: process.platform === 'win32' ? 'POSIX signal propagation is not a Windows promise; console interruption requires separately admitted native topology.' : 'Requires separately authorized real interruption topology; no signal sent or synthetic child substituted.' }));
  add('malformed-policy-preserved', async () => {
    put(globalState, '{malformed'); await cli(['global', 'enable'], { code: 1 }); assert.equal(readFileSync(globalState, 'utf8'), '{malformed');
    renameSync(globalState, join(c.root, 'retained-malformed-global.json'));
    put(projectState(), '{malformed'); await cli(['project', 'enable'], { cwd: c.repository, code: 1 }); assert.equal(readFileSync(projectState(), 'utf8'), '{malformed');
    renameSync(projectState(), join(c.root, 'retained-malformed-project.json'));
  });
  add('adapter-drift-refusal-force-repair', async () => {
    put(extension, 'task-owned drift\n'); await cli(['adapter', 'install', 'pi'], { code: 1, text: '--force' }); assert.equal(readFileSync(extension, 'utf8'), 'task-owned drift\n');
    await cli(['adapter', 'install', 'pi', '--force']); admitAdapter();
  });
  add('adapter-discovery-safe-uninstall', async () => {
    await cli(['adapter', 'uninstall', 'pi']); assert(!existsSync(extension)); adapterBinding = undefined; assert(existsSync(join(agent, 'extensions', '99-probe-provider.ts')));
    assert.equal(readFileSync(join(agent, 'extensions', 'unrelated.txt'), 'utf8'), 'unrelated adapter bystander');
    await print('after-uninstall', { enabled: false });
  });
  add('adapter-occupied-refusal-preserves-other-owner', async () => {
    put(extension, 'other owner\n'); await cli(['adapter', 'install', 'pi'], { code: 1, text: 'owned by another' }); assert.equal(readFileSync(extension, 'utf8'), 'other owner\n');
  });
  add('final-installed-byte-revalidation', c.revalidate);
  return resume ? steps.slice(steps.findIndex(step => step.name === 'deprecated-real-launch-and-natural-exit')) : steps;
}
