const fs=require('fs');
const b=fs.readFileSync('.github/workflows/android-npu-tests.yml');
const s=b.toString();
const lines=s.split('\n');
let tabFound=false;
lines.forEach((l,i)=>{
  if(l.includes('\t')){tabFound=true;console.log('TAB at line',i+1,':',JSON.stringify(l));}
});
console.log('Tabs found:',tabFound);
console.log('Total lines:',lines.length);
lines.forEach((l,i)=>{
  if(l !== l.trimEnd() && l.trim().length>0){
    console.log('Trailing whitespace at line',i+1,':',JSON.stringify(l));
  }
});
console.log('Done');
