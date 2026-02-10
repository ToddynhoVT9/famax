# Register your models here.
from django.contrib import admin
from .models import Topic, Thread, Post

admin.site.register(Topic)
admin.site.register(Thread)
admin.site.register(Post)