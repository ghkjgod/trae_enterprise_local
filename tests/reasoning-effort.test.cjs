process.env.API_KEY = require('crypto').randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepare, desktopAlias } = require('../src/enterprise-server');
const model = { id:'glm-test', upstream_model:'glm-test__dev', max_tokens:32000, reasoning_effort_options:['light','high','extra_high'], default_reasoning_effort:'high', effort_variants:['light','high','extra_high'].map(level=>({id:'glm-test@'+level,level,desktop_alias:desktopAlias('glm-test@'+level)})) };
const catalog={models:[model,{id:'two-level',upstream_model:'two__dev',reasoning_effort_options:['light','high'],default_reasoning_effort:'high'},{id:'fixed',upstream_model:'fixed__dev'}]};
const body={model:'glm-test',messages:[{role:'user',content:'test'}]};
test('OpenAI and Anthropic effort fields use the enterprise level contract',()=>{
 for(const [field,value,expected] of [['reasoning_effort','low','light'],['reasoning_effort','xhigh','extra_high'],['reasoning_effort_level','high','high'],['output_config',{effort:'max'},'extra_high'],['reasoning',{effort:'medium'},'high']]){
  assert.equal(prepare({...body,[field]:value},'anthropic',catalog).request.reasoning_effort_level,expected);
 }
});
test('Model-menu variants pin effort even if the client sends a global default',()=>{
 for(const v of model.effort_variants) for(const id of [v.id,v.desktop_alias]){
  const r=prepare({...body,model:id,output_config:{effort:'xhigh'}},'anthropic',catalog).request;
  assert.equal(r.reasoning_effort_level,v.level);assert.equal(r.model_name,'glm-test__dev');assert.equal(r.config_name,'glm-test');
 }
});
test('Unsupported and malformed effort cannot silently masquerade as applied',()=>{
 for(const value of [123,'none','invalid','__proto__']) assert.throws(()=>prepare({...body,reasoning_effort:value},'openai',catalog),/Unsupported/);
 assert.throws(()=>prepare({...body,model:'two-level',reasoning_effort:'xhigh'},'openai',catalog),/not available/);
 assert.throws(()=>prepare({...body,model:'fixed',reasoning_effort:'high'},'openai',catalog),/model default only/);
});
test('No selection follows known model defaults without inventing unsupported effort',()=>{
 assert.equal(prepare(body,'openai',catalog).request.reasoning_effort_level,'high');
 assert.equal(prepare({...body,model:'fixed'},'openai',catalog).request.reasoning_effort_level,undefined);
});
