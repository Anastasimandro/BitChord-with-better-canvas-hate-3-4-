let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const lines=d.split('\n');
  let inTest=false;
  lines.forEach(l=>{
    if(l.includes('Run NPU Parity Test')||l.includes('connectedDevDebugAndroidTest'))inTest=true;
    if(inTest && (l.includes('error')||l.includes('Error')||l.includes('FAIL')||l.includes('failed')||l.includes('Exception')||l.includes('BUILD')||l.includes('What went wrong')||l.includes('Could not'))) {
      console.log(l);
    }
  });
});
