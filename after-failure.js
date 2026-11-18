let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const lines=d.split('\n');
  let afterFailure=false;
  let count=0;
  lines.forEach(l=>{
    if(l.includes('FAILURE: Build failed')){afterFailure=true;count=0;}
    if(afterFailure && count<50){console.log(l);count++;}
  });
});
